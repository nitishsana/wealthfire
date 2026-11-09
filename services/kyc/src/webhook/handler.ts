// POST /webhooks/partner (design Â§3, task 8). Order of checks:
//   1. body size            > MAX_BODY_BYTES        â†’ 400 malformed
//   2. signature            KycPartner.verifyWebhook â†’ 401 bad_signature
//   3. envelope             parseEvent               â†’ 400 malformed
//   4. replay window        |now - timestamp| > 5 min â†’ 401 stale_event
//   5. duplicate            seen event id            â†’ 200 duplicate
//   6. apply + decide()     version-checked write, retried once on conflict; audit row
// Any other failure releases the event claim and answers 500 so the partner retries.
// Logs carry only the event id, type, outcome and status: never the body or partner values.
import type { KycConfig } from '../config';
import { actionFor, applyEvent, snapshot } from './apply';
import { MAX_BODY_BYTES, MalformedEventError, parseEvent, type PartnerEvent } from './events';
import type {
  SeenEventStore, WebhookAuditEntry, WebhookAuditLog, WebhookCaseStore, WebhookLogger, WebhookOutcome, WebhookVerifier,
} from './ports';

export const REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** How long a seen event id is remembered (well past the replay window). */
export const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
/** How long one run holds an event before a retry may take it over (Lambda timeout is 10 s). */
export const CLAIM_LEASE_MS = 60 * 1000;

export interface WebhookRequest {
  /** raw body as received; API Gateway base64 bodies are decoded by the Lambda adapter */
  body: string;
  headers: Record<string, string | undefined>;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface WebhookDeps {
  verifier: WebhookVerifier;
  cases: WebhookCaseStore;
  audit: WebhookAuditLog;
  seen: SeenEventStore;
  config: KycConfig;
  clock: { now(): number };
  log?: WebhookLogger;
}

export class CaseConflictError extends Error {
  constructor() {
    super('kyc case changed twice during webhook processing');
    this.name = 'CaseConflictError';
  }
}

export class MissingEvidenceError extends Error {
  constructor() {
    super('kyc case has no evidence');
    this.name = 'MissingEvidenceError';
  }
}

const noLog: WebhookLogger = () => undefined;

function lowerHeaders(h: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

function auditRow(e: PartnerEvent, outcome: WebhookOutcome, now: number, rest: Partial<WebhookAuditEntry>): WebhookAuditEntry {
  return {
    userId: e.userId,
    ts: `${new Date(now).toISOString()}#${e.id}`,
    actor: 'system',
    action: actionFor(e),
    eventId: e.id,
    outcome,
    before: null,
    after: null,
    ...(e.type === 'kyc.result' ? { check: e.data.check } : {}),
    ...rest,
  };
}

/** Applies a claimed event: one read-decide-write, retried once when the case changed meanwhile. */
async function applyClaimed(e: PartnerEvent, deps: WebhookDeps, now: number): Promise<WebhookOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stored = await deps.cases.get(e.userId);
    if (!stored) {
      await deps.audit.write(auditRow(e, 'ignored-unknown-case', now, {}));
      return 'ignored-unknown-case';
    }
    if (!stored.evidence) throw new MissingEvidenceError();
    const before = stored.kycCase;
    const r = applyEvent(before, stored.evidence, e, deps.config, now);
    if (r.kind === 'ignored') {
      await deps.audit.write(auditRow(e, r.outcome, now, { before: snapshot(before), after: snapshot(before) }));
      return r.outcome;
    }
    const audit = auditRow(e, 'applied', now, { before: snapshot(before), after: snapshot(r.after) });
    const saved = await deps.cases.save({
      before, after: r.after, evidence: r.evidence, audit,
      ...(r.next !== undefined ? { next: r.next } : {}),
      ...(r.unclear !== undefined ? { unclear: r.unclear } : {}),
    });
    if (saved === 'ok') return 'applied';
  }
  throw new CaseConflictError();
}

export async function handleWebhook(req: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  const log = deps.log ?? noLog;
  const body = typeof req.body === 'string' ? req.body : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES || body.length === 0) {
    log({ msg: 'webhook.rejected', status: 400, error: 'size' });
    return { status: 400, body: { error: 'malformed' } };
  }

  let signed = false;
  try {
    signed = deps.verifier.verifyWebhook(lowerHeaders(req.headers), body) === true;
  } catch {
    signed = false;
  }
  if (!signed) {
    log({ msg: 'webhook.rejected', status: 401, error: 'bad_signature' });
    return { status: 401, body: { error: 'bad_signature' } };
  }

  let e: PartnerEvent;
  try {
    e = parseEvent(body);
  } catch (err) {
    const field = err instanceof MalformedEventError ? err.field : 'unknown';
    log({ msg: 'webhook.rejected', status: 400, error: `malformed:${field}` });
    return { status: 400, body: { error: 'malformed' } };
  }

  const now = deps.clock.now();
  if (Math.abs(now - e.timestamp) > REPLAY_WINDOW_MS) {
    log({ msg: 'webhook.rejected', eventId: e.id, type: e.type, status: 401, error: 'stale_event' });
    return { status: 401, body: { error: 'stale_event' } };
  }

  if ((await deps.seen.claim(e.id, now, CLAIM_LEASE_MS, SEEN_TTL_MS)) === 'duplicate') {
    log({ msg: 'webhook.done', eventId: e.id, type: e.type, outcome: 'duplicate', status: 200 });
    return { status: 200, body: { ok: true, outcome: 'duplicate' } };
  }

  try {
    const outcome = await applyClaimed(e, deps, now);
    await deps.seen.complete(e.id, deps.clock.now(), SEEN_TTL_MS);
    log({ msg: 'webhook.done', eventId: e.id, type: e.type, outcome, status: 200 });
    return { status: 200, body: { ok: true, outcome } };
  } catch (err) {
    try {
      await deps.seen.release(e.id);
    } catch {
      // the lease runs out on its own
    }
    log({ msg: 'webhook.failed', eventId: e.id, type: e.type, status: 500, error: (err as { name?: string })?.name ?? 'Error' });
    return { status: 500, body: { error: 'internal' } };
  }
}
