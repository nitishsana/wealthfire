import { DEFAULT_CONFIG } from '../../src/config';
import { FakeClock } from '../../src/lib/clock';
import { memoryStore } from '../../src/store/memory';
import type { KycCaseRecord } from '../../src/store/types';
import { webhookCaseStore } from '../../src/store/views';
import type { KycCase } from '../../src/types';
import { handleWebhook, type WebhookDeps, type WebhookResponse } from '../../src/webhook/handler';
import { HmacWebhookVerifier, SIGNATURE_HEADER, signBody } from '../../src/webhook/hmac';
import { MemorySeenEventStore } from '../../src/webhook/memory';
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

/** A full kyc_cases item as /kyc/start writes it (the webhook must keep the extra fields). */
export function baseRecord(kycCase: KycCase, evidence: CaseEvidence | null): KycCaseRecord {
  return {
    createdAt: '2026-11-06T10:00:00.000Z',
    panEnc: 'l1.enc',
    panHash: 'pan-hash',
    next: 'kra-lookup',
    ...kycCase,
    ...(evidence !== null ? { evidence } : {}),
  } as KycCaseRecord;
}

export function setup(opts: { kycCase?: KycCase | null; evidence?: CaseEvidence | null } = {}) {
  const clock = new FakeClock();
  // the shared store: the webhook reads/writes it through its thin view
  const store = memoryStore();
  const cases = webhookCaseStore(store.cases);
  const seen = new MemorySeenEventStore();
  const logs: WebhookLogFields[] = [];
  if (opts.kycCase !== null) {
    void store.cases.put(baseRecord(opts.kycCase ?? baseCase(), opts.evidence === undefined ? baseEvidence() : opts.evidence));
  }
  const deps: WebhookDeps = {
    verifier: new HmacWebhookVerifier(SECRET),
    cases,
    audit: store.audit,
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
  /** audit rows written together with a case change (outcome applied), oldest first */
  const applied = () => store.audit.all().filter((r) => r.outcome === 'applied');
  /** audit rows for signed events that changed nothing, oldest first */
  const ignored = () => store.audit.all().filter((r) => r.outcome !== undefined && r.outcome !== 'applied');
  return { clock, store, cases, seen, logs, deps, event, send, stored, applied, ignored };
}

export { SIGNATURE_HEADER, signBody };
