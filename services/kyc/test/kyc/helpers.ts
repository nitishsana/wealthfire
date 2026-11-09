import { expect } from 'vitest';
import { DEFAULT_CONFIG, type KycConfig } from '../../src/config';
import { MemoryLogger } from '../../src/kyc/log';
import { CONSENT_PURPOSES, memoryKycRepos, type ConsentRepo } from '../../src/kyc/repo';
import { kycRoutes } from '../../src/kyc/routes';
import { KycService } from '../../src/kyc/service';
import { FakeStaffVerifier } from '../../src/kyc/staff';
import { FakeUploadSigner } from '../../src/kyc/uploads';
import { FakePartner } from '../../src/partner/fake';
import { reviewRoutes } from '../../src/review/routes';
import { createRouter, type HttpRequest, type HttpResponse } from '../../src/router';
import { reviewCaseStore, webhookCaseStore } from '../../src/store/views';
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

/** Records a consent row for every purpose (what the apps do before each paid step). */
export async function grantAllConsents(repos: { consents: ConsentRepo }, userId: string, at = '2026-01-01T00:00:00.000Z'): Promise<void> {
  for (const purpose of CONSENT_PURPOSES) {
    await repos.consents.record({ userId, sk: `${purpose}#${at}#seed`, purpose, action: 'given', at });
  }
}

/**
 * `consents: false` signs users in without any consent rows (S2 tests).
 * `documents: 'uploaded'` makes the review routes list only what was really uploaded (default: a
 * stub that always has the selfie, Aadhaar and PAN).
 */
export function env(cfg: Partial<KycConfig> = {}, opts: { consents?: boolean; documents?: 'stub' | 'uploaded' } = {}) {
  const a = authSetup();
  const repos = memoryKycRepos();
  const partner = new FakePartner();
  const uploads = new FakeUploadSigner();
  const logger = new MemoryLogger();
  const staff = new FakeStaffVerifier();
  staff.add('staff-token-reviewer-0001', { id: 'staff-1', groups: ['reviewer'] });
  staff.add('staff-token-viewer-00001', { id: 'staff-2', groups: ['viewer'] });
  const config: KycConfig = { ...DEFAULT_CONFIG, ...cfg };
  // the production default allow-list (https://nitishsana.github.io/wealthfire/, 127.0.0.1:5180, wealthfire://)
  const svc = new KycService({ repos, partner, uploads, encryptor: a.encryptor, mac: a.mac, clock: a.clock, config });
  // the review routes and the webhook view use the SAME store and audit log as the KYC routes
  const review = reviewRoutes({
    cases: reviewCaseStore(repos.cases),
    audit: repos.audit,
    documents: {
      list: async (id: string) => opts.documents === 'uploaded'
        // what the fake S3 holds under kyc/<userId>/ (the review console's S3DocumentStore layout)
        ? uploads.keys().filter((k) => k.startsWith(`kyc/${id}/`)).map((key) => {
          const file = key.slice(`kyc/${id}/`.length);
          return { kind: file.slice(0, file.indexOf('-')) as 'selfie' | 'aadhaar' | 'pan', key };
        })
        // default stub: all three documents present, so staff Approve is allowed (R1)
        : (['selfie', 'aadhaar', 'pan'] as const).map((kind) => ({ kind, key: `kyc/${id}/${kind}-stub.jpg` })),
    },
    signer: { sign: async () => 'https://signed.invalid/x' },
    clock: a.clock,
    onApproved: async (userId) => void (await svc.uploadToKra(userId)),
  });
  const webhookCases = webhookCaseStore(repos.cases);
  /** staff (review.*) audit rows, oldest first */
  const reviewAudit = () => repos.audit.all().filter((r) => r.action.startsWith('review.'));
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
    if (opts.idem !== null && method === 'POST' && path.startsWith('/kyc/') && path !== '/kyc/documents' && !path.startsWith('/kyc/consent')) {
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
    const token = v.json.accessToken as string;
    if (opts.consents !== false) await grantAllConsents(repos, (await a.tokens.authenticate(token)).sub);
    return token;
  }
  async function userIdOf(token: string): Promise<string> {
    return (await a.tokens.authenticate(token)).sub;
  }
  /** Upload a selfie (presign + simulated PUT) and return its uploadId. */
  async function uploadSelfie(token: string): Promise<string> {
    const r = await call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'selfie', contentType: 'image/jpeg', size: 200_000 }] } });
    expect(r.statusCode, JSON.stringify(r.json)).toBe(200);
    const up = r.json.uploads[0];
    uploads.markUploaded(uploads.signed[uploads.signed.length - 1]!.key);
    return up.uploadId as string;
  }
  /** Upload one document of `kind` (presign + simulated PUT, optional raw first bytes); returns its uploadId and key. */
  async function uploadDoc(token: string, kind: 'selfie' | 'aadhaar' | 'pan', contentType = 'image/jpeg', bytes?: Uint8Array) {
    const r = await call('POST', '/kyc/documents', { token, body: { files: [{ kind, contentType, size: 200_000 }] } });
    expect(r.statusCode).toBe(200);
    const key = uploads.signed[uploads.signed.length - 1]!.key;
    uploads.markUploaded(key, bytes);
    return { uploadId: r.json.uploads[0].uploadId as string, key, response: r };
  }
  return {
    ...a, repos, partner, uploads, logger, staff, svc, router, call, signIn, userIdOf, uploadSelfie, uploadDoc, seen, config, reviewAudit,
    webhookCases,
  };
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
