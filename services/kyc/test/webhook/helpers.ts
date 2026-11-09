import { DEFAULT_CONFIG } from '../../src/config';
import { FakeClock } from '../../src/lib/clock';
import type { KycCase } from '../../src/types';
import { handleWebhook, type WebhookDeps, type WebhookResponse } from '../../src/webhook/handler';
import { HmacWebhookVerifier, SIGNATURE_HEADER, signBody } from '../../src/webhook/hmac';
import { MemorySeenEventStore, MemoryWebhookAuditLog, MemoryWebhookCaseStore } from '../../src/webhook/memory';
import type { CaseEvidence, WebhookLogFields } from '../../src/webhook/ports';

export const SECRET = 'test-webhook-secret-0123456789';
export const USER = 'user-1';

export function baseCase(over: Partial<KycCase> = {}): KycCase {
  return {
    userId: USER,
    status: 'pre-verified',
    path: null,
    masks: { pan: 'XXXXXX234F', aadhaar: 'XXXXXXXX1234' },
    partnerRefs: {},
    checks: {},
    reason: null,
    updatedAt: '2026-11-06T11:00:00.000Z',
    version: 1,
    ...over,
  };
}

export function baseEvidence(over: Partial<CaseEvidence> = {}): CaseEvidence {
  return {
    deviceHandCheck: false,
    typed: { firstName: 'Nitish', lastName: 'Sana', dob: '15/08/1990' },
    panIndividual: true,
    otpAadhaarLast4: '1234',
    ...over,
  };
}

export function setup(opts: { kycCase?: KycCase | null; evidence?: CaseEvidence | null } = {}) {
  const clock = new FakeClock();
  const cases = new MemoryWebhookCaseStore();
  const audit = new MemoryWebhookAuditLog();
  const seen = new MemorySeenEventStore();
  const logs: WebhookLogFields[] = [];
  if (opts.kycCase !== null) cases.put(opts.kycCase ?? baseCase(), opts.evidence === undefined ? baseEvidence() : opts.evidence);
  const deps: WebhookDeps = {
    verifier: new HmacWebhookVerifier(SECRET),
    cases,
    audit,
    seen,
    config: { ...DEFAULT_CONFIG },
    clock,
    log: (f) => logs.push(f),
  };
  let n = 0;
  /** Builds a signed event; `at` offsets occurredAt from now (ms). */
  const event = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: `evt_${++n}`,
    type,
    timestamp: clock.now(),
    userId: USER,
    data,
    ...extra,
  });
  const send = (payload: unknown, sign: string | null = SECRET): Promise<WebhookResponse> => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers: Record<string, string> = sign === null ? {} : { 'X-Webhook-Signature': `sha256=${signBody(sign, body)}` };
    return handleWebhook({ body, headers }, deps);
  };
  const stored = async () => (await cases.get(USER))!;
  return { clock, cases, audit, seen, logs, deps, event, send, stored };
}

export { SIGNATURE_HEADER, signBody };
