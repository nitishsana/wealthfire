import { expect } from 'vitest';
import { DEFAULT_CONFIG, type KycConfig } from '../../src/config';
import { MemoryLogger } from '../../src/kyc/log';
import { memoryKycRepos, type KycCaseRecord, type MemoryKycCaseRepo } from '../../src/kyc/repo';
import { kycRoutes } from '../../src/kyc/routes';
import { KycService } from '../../src/kyc/service';
import { FakeStaffVerifier } from '../../src/kyc/staff';
import { FakeUploadSigner } from '../../src/kyc/uploads';
import { FakePartner } from '../../src/partner/fake';
import type { AuditEntry, AuditLog, CasePage, ReviewCaseStore } from '../../src/review/ports';
import { reviewRoutes } from '../../src/review/routes';
import { createRouter, type HttpRequest, type HttpResponse } from '../../src/router';
import { MOBILE, setup as authSetup } from '../auth/helpers';

export const RETURN_URL = 'https://nitishsana.github.io/wealthfire/kyc/return';
export const ORIGIN = 'https://nitishsana.github.io';

/** PANs that pick each FakePartner scenario. */
export const PANS = {
  kraValidated: 'ABCPR0001K',
  fullPass: 'ABCPR0002K',
  unclear: 'ABCPR0003K',
  reject: 'ABCPR0004K',
  timeout: 'ABCPR0005K',
  company: 'ABCCR0002K', // 4th char C: not an individual
} as const;

export const AADHAAR_LAST4 = '1234';
/** a full Aadhaar a client might wrongly send; must never be stored or echoed */
export const FULL_AADHAAR = '234567891234';

export const startBody = (pan: string, over: Record<string, unknown> = {}) => ({
  firstName: 'Asha', lastName: 'Rao', dob: '15/08/1990', pan, aadhaarLast4: AADHAAR_LAST4, deviceResult: 'pre-verified', ...over,
});

/** ReviewCaseStore over the KYC case repo, so staff decisions hit the same records. */
class ReviewOverKyc implements ReviewCaseStore {
  constructor(private readonly cases: MemoryKycCaseRepo, private readonly audit: AuditLog) {}
  async listUnderReview(q: { limit: number }): Promise<CasePage> {
    return { items: this.cases.all().filter((c) => c.status === 'under-review').slice(0, q.limit) };
  }
  async get(id: string) {
    return this.cases.get(id);
  }
  async saveDecision(w: { before: KycCaseRecord; after: KycCaseRecord; audit: AuditEntry }) {
    const ok = await this.cases.save(w.after as KycCaseRecord, w.before.version);
    if (!ok) return 'conflict' as const;
    await this.audit.write(w.audit);
    return 'ok' as const;
  }
}

export function env(cfg: Partial<KycConfig> = {}) {
  const a = authSetup();
  const repos = memoryKycRepos();
  const partner = new FakePartner();
  const uploads = new FakeUploadSigner();
  const logger = new MemoryLogger();
  const staff = new FakeStaffVerifier();
  staff.add('staff-token-reviewer-0001', { id: 'staff-1', groups: ['reviewer'] });
  staff.add('staff-token-viewer-00001', { id: 'staff-2', groups: ['viewer'] });
  const config: KycConfig = { ...DEFAULT_CONFIG, ...cfg };
  const svc = new KycService({
    repos, partner, uploads, encryptor: a.encryptor, mac: a.mac, clock: a.clock, config,
    returnUrlPrefixes: [`${ORIGIN}/`, 'wealthfire://'],
  });
  const reviewAudit: AuditEntry[] = [];
  const review = reviewRoutes({
    cases: new ReviewOverKyc(repos.cases, { write: async (e) => void reviewAudit.push(e), listForUser: async () => [] }),
    audit: { write: async (e) => void reviewAudit.push(e), listForUser: async () => [] },
    documents: { list: async () => [] },
    signer: { sign: async () => 'https://signed.invalid/x' },
    clock: a.clock,
  });
  const router = createRouter({
    auth: { otp: a.otp, tokens: a.tokens, clock: a.clock },
    tokens: a.tokens,
    kyc: kycRoutes(svc),
    review,
    staff,
    allowedOrigins: [ORIGIN],
    logger,
    clock: a.clock,
  });
  /** every response body seen, for the leak checks */
  const seen: string[] = [];
  let n = 0;
  async function call(method: string, path: string, opts: { body?: unknown; token?: string; idem?: string | null; headers?: Record<string, string> } = {}): Promise<HttpResponse & { json: Record<string, any> }> {
    const headers: Record<string, string> = { origin: ORIGIN, ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.idem !== null && method === 'POST' && path.startsWith('/kyc/') && path !== '/kyc/documents') {
      headers['Idempotency-Key'] = opts.idem ?? `idem-key-${++n}`;
    }
    const req: HttpRequest = {
      method, path, headers, query: {}, ip: '203.0.113.7',
      ...(opts.body !== undefined ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) } : {}),
    };
    const res = await router(req);
    seen.push(res.body, JSON.stringify(res.headers), res.cookies.join(';'));
    return { ...res, json: JSON.parse(res.body) };
  }
  let users = 0;
  /** Signs in a new user (or `contact`'s user again) and returns the access token. */
  async function signIn(contact: string = users++ === 0 ? MOBILE : `+91 98765 ${String(40000 + users).slice(-5)}`): Promise<string> {
    const sent = await call('POST', '/auth/otp/send', { body: { kind: 'mobile', contact } });
    expect(sent.statusCode).toBe(200);
    const v = await call('POST', '/auth/otp/verify', { body: { challengeId: sent.json.challengeId, code: a.sender.lastCode } });
    expect(v.statusCode).toBe(200);
    // the next sign-in for another user must not hit the resend cooldown
    a.clock.advance(60_000);
    return v.json.accessToken as string;
  }
  async function userIdOf(token: string): Promise<string> {
    return (await a.tokens.authenticate(token)).sub;
  }
  /** Upload a selfie (presign + simulated PUT) and return its uploadId. */
  async function uploadSelfie(token: string): Promise<string> {
    const r = await call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'selfie', contentType: 'image/jpeg', size: 200_000 }] } });
    expect(r.statusCode).toBe(200);
    const up = r.json.uploads[0];
    uploads.markUploaded(uploads.signed[uploads.signed.length - 1]!.key);
    return up.uploadId as string;
  }
  return { ...a, repos, partner, uploads, logger, staff, svc, router, call, signIn, userIdOf, uploadSelfie, seen, config, reviewAudit };
}

export type Env = ReturnType<typeof env>;

/** Walk a full-KYC case from start to the e-sign result. */
export async function fullKyc(e: Env, token: string, pan: string = PANS.fullPass) {
  const userId = await e.userIdOf(token);
  const s = await e.call('POST', '/kyc/start', { token, body: startBody(pan) });
  expect(s.statusCode).toBe(200);
  expect(s.json.next).toBe('aadhaar');
  const a = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
  expect(a.statusCode).toBe(200);
  await e.svc.recordAadhaar(userId, { verified: true, last4: AADHAAR_LAST4 }); // webhook
  const afterPan = await e.call('GET', '/kyc/status', { token });
  return { userId, start: s, aadhaar: a, afterPan };
}
