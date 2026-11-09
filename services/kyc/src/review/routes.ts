// Staff review routes (design §3 `/review/*`, R4). Pure handlers: the API adapter verifies the
// Cognito token, fills `staff` from its claims (sub + cognito:groups) and maps the response.
// These handlers check the `reviewer` group again, so a wiring mistake cannot open them up.
//
// Responses carry masked values only (rebuilt from the last 4), whitelisted fields only, and
// document links that expire after 5 minutes. Every Approve / Reject writes an audit row in the
// same transaction as the case update; opening a case (which signs document links) is audited too.
import { randomUUID } from 'node:crypto';
import { KycTransitionError, staffDecide, type StaffAction } from '../decide';
import type { Clock } from '../lib/clock';
import type { CheckName, CheckResult, KycCase } from '../types';
import { looksLikeIdNumber, maskAadhaar, maskPan } from './mask';
import {
  BadCursorError,
  type AuditEntry,
  type AuditLog,
  type CaseSnapshot,
  type DocumentStore,
  type DownloadSigner,
  type ReviewCaseStore,
} from './ports';

export const REVIEWER_GROUP = 'reviewer';
/** Presigned document GET lifetime. */
export const DOC_URL_TTL_SEC = 300;
export const REASON_MAX = 200;
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;
const HISTORY_LIMIT = 50;
const BODY_MAX = 4096;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CHECK_NAMES: readonly CheckName[] = [
  'kra', 'kra-name', 'kra-dob', 'aadhaar', 'pan', 'pan-name', 'pan-aadhaar-link', 'face-match', 'liveness', 'esign',
];
const CHECK_RESULTS: readonly CheckResult[] = ['pass', 'fail', 'unclear'];

export interface ReviewRequest {
  params: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  /** parsed JSON or the raw string body */
  body: unknown;
  /** from the verified Cognito token: sub and cognito:groups */
  staff: { id: string; groups: string[] };
}

export interface ReviewResponse {
  status: number;
  body: unknown;
}

export type Handler = (req: ReviewRequest) => Promise<ReviewResponse>;

export interface ReviewDeps {
  cases: ReviewCaseStore;
  audit: AuditLog;
  documents: DocumentStore;
  signer: DownloadSigner;
  clock: Clock;
  /** audit ts nonce; injectable for tests */
  nonce?: () => string;
  /**
   * System follow-up after a saved Approve (the KRA upload, KycService.uploadToKra). Runs after the
   * decision is stored; a failure does not undo the approval: the step stays pending ('kra-upload')
   * and is retried by the next GET /kyc/status, so it is retry-safe.
   */
  onApproved?: (userId: string) => Promise<void>;
}

type ErrorCode = 'bad_request' | 'forbidden' | 'not_found' | 'conflict' | 'illegal_transition' | 'internal';

const MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'Check the details and try again.',
  forbidden: 'You do not have reviewer access.',
  not_found: 'Case not found.',
  conflict: 'This case changed while you were looking at it. Reload and try again.',
  illegal_transition: 'Only an Under-review case can be approved or rejected.',
  internal: 'Something went wrong. Try again.',
};
const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, forbidden: 403, not_found: 404, conflict: 409, illegal_transition: 409, internal: 500,
};

class ReviewError extends Error {
  constructor(readonly code: ErrorCode, readonly detail?: string) {
    super(MESSAGES[code]);
  }
}

function errorResponse(e: unknown): ReviewResponse {
  if (e instanceof ReviewError) {
    return { status: STATUS[e.code], body: { error: e.code, message: e.detail ?? e.message } };
  }
  if (e instanceof BadCursorError) return errorResponse(new ReviewError('bad_request', 'That page link is not valid.'));
  if (e instanceof KycTransitionError) return errorResponse(new ReviewError('illegal_transition'));
  return { status: 500, body: { error: 'internal', message: MESSAGES.internal } };
}

/** Group check + uniform error mapping around every handler. */
function guarded(fn: Handler): Handler {
  return async (req) => {
    try {
      const staff = req.staff;
      if (!staff || typeof staff.id !== 'string' || staff.id.trim() === '' || !Array.isArray(staff.groups)
        || !staff.groups.includes(REVIEWER_GROUP)) {
        throw new ReviewError('forbidden');
      }
      return await fn(req);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

function parseBody(body: unknown): Record<string, unknown> {
  let v = body;
  if (typeof v === 'string') {
    if (v.length > BODY_MAX) throw new ReviewError('bad_request');
    if (v.trim() === '') return {};
    try {
      v = JSON.parse(v);
    } catch {
      throw new ReviewError('bad_request');
    }
  }
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ReviewError('bad_request');
  return v as Record<string, unknown>;
}

function caseId(req: ReviewRequest): string {
  const id = req.params?.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ReviewError('bad_request', 'That case id is not valid.');
  return id;
}

function cleanChecks(checks: KycCase['checks'] | undefined): Partial<Record<CheckName, CheckResult>> {
  const out: Partial<Record<CheckName, CheckResult>> = {};
  for (const name of CHECK_NAMES) {
    const r = checks?.[name];
    if (r !== undefined && CHECK_RESULTS.includes(r)) out[name] = r;
  }
  return out;
}

/** Whitelisted, masked view of a case. Never spreads the stored item. */
function caseView(c: KycCase) {
  const checks = cleanChecks(c.checks);
  return {
    id: c.userId,
    status: c.status,
    path: c.path,
    reason: c.reason,
    updatedAt: c.updatedAt,
    version: c.version,
    masks: { pan: maskPan(c.masks?.pan), aadhaar: maskAadhaar(c.masks?.aadhaar) },
    checks,
    unclear: CHECK_NAMES.filter((n) => checks[n] === 'unclear'),
  };
}

function snapshot(c: KycCase): CaseSnapshot {
  return { status: c.status, path: c.path, reason: c.reason, version: c.version };
}

function auditTs(deps: ReviewDeps): string {
  return `${new Date(deps.clock.now()).toISOString()}#${(deps.nonce ?? randomUUID)()}`;
}

function staffActor(req: ReviewRequest): `staff:${string}` {
  return `staff:${req.staff.id}`;
}

// ---------- handlers ----------

/** GET /review/cases?limit=&cursor= -> 200 {items, nextCursor?}; Under-review only, newest first. */
function listCases(deps: ReviewDeps): Handler {
  return guarded(async (req) => {
    const rawLimit = req.query?.limit;
    let limit = PAGE_DEFAULT;
    if (rawLimit !== undefined && rawLimit !== '') {
      if (!/^\d{1,3}$/.test(rawLimit)) throw new ReviewError('bad_request', 'limit must be a number.');
      limit = Math.min(PAGE_MAX, Math.max(1, Number(rawLimit)));
    }
    const cursor = req.query?.cursor || undefined;
    if (cursor !== undefined && cursor.length > 1024) throw new BadCursorError();
    const page = await deps.cases.listUnderReview({ limit, ...(cursor ? { cursor } : {}) });
    const items = page.items
      .filter((c) => c.status === 'under-review')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map(caseView);
    return { status: 200, body: { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
  });
}

/** GET /review/cases/{id} -> 200 {case, documents, history}; audited as review.view. */
function getCase(deps: ReviewDeps): Handler {
  return guarded(async (req) => {
    const id = caseId(req);
    const c = await deps.cases.get(id);
    if (!c) throw new ReviewError('not_found');
    const now = deps.clock.now();
    // Audit before handing out document links: no audit row, no links.
    await deps.audit.write({
      userId: id, ts: auditTs(deps), actor: staffActor(req), action: 'review.view', before: snapshot(c), after: null,
    });
    const docs = await deps.documents.list(id);
    const expiresAt = new Date(now + DOC_URL_TTL_SEC * 1000).toISOString();
    const documents = await Promise.all(
      docs.map(async (d, i) => ({
        id: `${d.kind}-${i + 1}`,
        kind: d.kind,
        ...(d.uploadedAt ? { uploadedAt: d.uploadedAt } : {}),
        url: await deps.signer.sign(d.key, DOC_URL_TTL_SEC),
        expiresAt,
      })),
    );
    const history = (await deps.audit.listForUser(id, HISTORY_LIMIT)).map((h) => ({
      ts: h.ts.split('#')[0],
      actor: h.actor,
      action: h.action,
      from: h.before?.status ?? null,
      to: h.after?.status ?? null,
      ...(h.note ? { note: h.note } : {}),
    }));
    return { status: 200, body: { case: caseView(c), documents, history } };
  });
}

function readText(b: Record<string, unknown>, field: string, required: boolean): string | undefined {
  const v = b[field];
  if (v === undefined || v === null || (!required && v === '')) {
    if (required) throw new ReviewError('bad_request', `A ${field} is required (1-${REASON_MAX} characters).`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ReviewError('bad_request');
  const t = v.trim();
  if (t.length < (required ? 1 : 0) || t.length > REASON_MAX) {
    throw new ReviewError('bad_request', `The ${field} must be 1-${REASON_MAX} characters.`);
  }
  if (looksLikeIdNumber(t)) {
    throw new ReviewError('bad_request', `Do not put PAN, Aadhaar or other ID numbers in the ${field}.`);
  }
  return t === '' ? undefined : t;
}

/**
 * POST /review/cases/{id}  body {action: 'approve'|'reject', reason?, note?, version?}
 * -> 200 {case}; 400 bad body / missing reason; 404; 409 not under review or changed meanwhile.
 */
function decideCase(deps: ReviewDeps): Handler {
  return guarded(async (req) => {
    const id = caseId(req);
    const b = parseBody(req.body);
    let action: StaffAction;
    if (b.action === 'approve') {
      const note = readText(b, 'note', false);
      action = { kind: 'approve', staffId: req.staff.id, ...(note ? { note } : {}) };
    } else if (b.action === 'reject') {
      action = { kind: 'reject', staffId: req.staff.id, reason: readText(b, 'reason', true) as string };
    } else {
      throw new ReviewError('bad_request', "action must be 'approve' or 'reject'.");
    }
    const expected = b.version;
    if (expected !== undefined && (typeof expected !== 'number' || !Number.isInteger(expected))) {
      throw new ReviewError('bad_request');
    }

    const before = await deps.cases.get(id);
    if (!before) throw new ReviewError('not_found');
    if (expected !== undefined && expected !== before.version) throw new ReviewError('conflict');

    const d = staffDecide({ status: before.status, path: before.path }, action); // throws on illegal moves
    const after: KycCase = {
      ...before,
      status: d.status,
      path: d.path,
      reason: d.reason,
      checks: before.checks, // staffDecide does not re-run checks; keep the evidence
      updatedAt: new Date(deps.clock.now()).toISOString(),
      version: before.version + 1,
    };
    if (d.note) after.note = d.note;
    else delete after.note;

    const audit: AuditEntry = {
      userId: id,
      ts: auditTs(deps),
      actor: staffActor(req),
      action: action.kind === 'approve' ? 'review.approve' : 'review.reject',
      before: snapshot(before),
      after: snapshot(after),
      ...(d.note ? { note: d.note } : {}),
    };
    const r = await deps.cases.saveDecision({ before, after, next: d.next, audit });
    if (r === 'conflict') throw new ReviewError('conflict');
    let view = caseView(after);
    if (action.kind === 'approve' && deps.onApproved) {
      try {
        await deps.onApproved(id);
        const fresh = await deps.cases.get(id);
        if (fresh) view = caseView(fresh);
      } catch {
        // retried by GET /kyc/status; the approval itself is stored and audited
      }
    }
    return { status: 200, body: { case: view } };
  });
}

/** Route table for the API adapter. Keys use the API Gateway `{id}` path style. */
export function reviewRoutes(deps: ReviewDeps): Record<string, Handler> {
  return {
    'GET /review/cases': listCases(deps),
    'GET /review/cases/{id}': getCase(deps),
    'POST /review/cases/{id}': decideCase(deps),
  };
}
