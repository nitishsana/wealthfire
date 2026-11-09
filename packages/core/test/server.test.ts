import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  HttpOtpProvider,
  ServerError,
  ServerKycClient,
  emptyData,
  emptyOnboarding,
  isEligibleToInvest,
  serverEligibleToInvest,
  toKycStatusView,
  type ServerFetchInit,
  type KycStatusView,
  type TokenStore,
} from '../src';

const BASE = 'https://api.example.test';
const PAN = 'ABCPE1234F';
const AADHAAR = '234123412346';

interface Call { url: string; init: ServerFetchInit }
type Reply = { status: number; body?: unknown } | 'network-error';

/** Fake fetch: replies in order per "METHOD path", records every call. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: ServerFetchInit) => {
    calls.push({ url, init });
    const key = `${init.method} ${url.slice(BASE.length)}`;
    const q = routes[key];
    const r = q && q.length > 1 ? q.shift()! : q?.[0];
    if (!r) return { status: 404, text: async () => JSON.stringify({ error: 'not_found', message: 'Not found.' }) };
    if (r === 'network-error') throw new TypeError(`failed to fetch ${url} ${init.body ?? ''}`);
    return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  return { fetch, calls };
}

function memTokens(access: string | null = 'A1', refresh: string | null = null): TokenStore & { access: string | null; refresh: string | null } {
  const s = {
    access, refresh,
    async get() { return s.access; },
    async set(v: string | null) { s.access = v; },
    async getRefresh() { return s.refresh; },
    async setRefresh(v: string | null) { s.refresh = v; },
  };
  return s;
}

const statusBody = (over: Record<string, unknown> = {}) => ({
  status: 'pre-verified', path: null, reason: 'in-progress', next: 'aadhaar', eligibleToInvest: false,
  masks: { pan: 'XXXXXX234F', aadhaar: 'XXXX XXXX 2346' }, ...over,
});

const tokenBody = (n: number, refresh = true) => ({
  userId: 'u1', accessToken: `A${n}`, accessExpiresAt: 1, refreshExpiresAt: 2, ...(refresh ? { refreshToken: `R${n}` } : {}),
});

let keySeq = 0;
const newKey = () => `idem-key-${++keySeq}`;

describe('ServerKycClient auth', () => {
  it('sendOtp posts kind + contact; web sends x-wf-client and credentials', async () => {
    const f = fakeFetch({ 'POST /auth/otp/send': [{ status: 200, body: { challengeId: 'c'.repeat(22), expiresAt: 10, resendAt: 5 } }] });
    const c = new ServerKycClient({ baseUrl: `${BASE}/`, fetch: f.fetch, tokens: memTokens(null) });
    await expect(c.sendOtp('mobile', '9876543210')).resolves.toEqual({ challengeId: 'c'.repeat(22), expiresAt: 10, resendAt: 5 });
    expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ kind: 'mobile', contact: '9876543210' });
    expect(f.calls[0]!.init.headers['x-wf-client']).toBe('web');
    expect(f.calls[0]!.init.credentials).toBe('include');
    expect(f.calls[0]!.init.headers.authorization).toBeUndefined();
  });

  it('verifyOtp stores the access token (web: refresh stays in the cookie)', async () => {
    const t = memTokens(null);
    const f = fakeFetch({ 'POST /auth/otp/verify': [{ status: 200, body: tokenBody(1, false) }] });
    await new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t }).verifyOtp('c'.repeat(22), '123456');
    expect(t.access).toBe('A1');
    expect(t.refresh).toBeNull();
  });

  it('app client keeps the refresh token in the store and sends it on refresh / logout', async () => {
    const t = memTokens(null);
    const f = fakeFetch({
      'POST /auth/otp/verify': [{ status: 200, body: tokenBody(1) }],
      'GET /kyc/status': [{ status: 401, body: { error: 'unauthorized' } }, { status: 200, body: statusBody() }],
      'POST /auth/refresh': [{ status: 200, body: tokenBody(2) }],
      'POST /auth/logout': [{ status: 200, body: { ok: true } }],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t, client: 'app' });
    await c.verifyOtp('c'.repeat(22), '123456');
    expect([t.access, t.refresh]).toEqual(['A1', 'R1']);
    expect(f.calls[0]!.init.headers['x-wf-client']).toBeUndefined();
    await c.getStatus();
    const refreshCall = f.calls.find((x) => x.url.endsWith('/auth/refresh'))!;
    expect(JSON.parse(refreshCall.init.body!)).toEqual({ refreshToken: 'R1' });
    expect([t.access, t.refresh]).toEqual(['A2', 'R2']);
    await c.logout();
    expect(JSON.parse(f.calls.at(-1)!.init.body!)).toEqual({ refreshToken: 'R2' });
    expect([t.access, t.refresh]).toEqual([null, null]);
  });

  it('logout clears local tokens even when the server is unreachable', async () => {
    const t = memTokens('A1', 'R1');
    const f = fakeFetch({ 'POST /auth/logout': ['network-error'] });
    await expect(new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t, client: 'app' }).logout()).rejects.toMatchObject({ code: 'network' });
    expect([t.access, t.refresh]).toEqual([null, null]);
  });
});

describe('ServerKycClient 401 handling', () => {
  it('401 -> refresh once -> retry with the new token and the same Idempotency-Key', async () => {
    const t = memTokens('OLD');
    const f = fakeFetch({
      'POST /kyc/start': [{ status: 401, body: { error: 'unauthorized' } }, { status: 200, body: statusBody() }],
      'POST /auth/refresh': [{ status: 200, body: tokenBody(2, false) }],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t, newKey });
    const v = await c.startKyc({
      firstName: 'Asha', lastName: 'Rao', dob: '1990-01-31', pan: PAN, aadhaarLast4: '2346', deviceStatus: 'pre-verified',
      reviewFields: [{ field: 'pan', typedMasked: 'XXXXXX234F', readMasked: 'XXXXXX234F' }],
    });
    expect(v).toEqual({ status: 'pre-verified', reason: 'in-progress', next: { type: 'digilocker' } });
    const starts = f.calls.filter((x) => x.url.endsWith('/kyc/start'));
    expect(starts.map((x) => x.init.headers.authorization)).toEqual(['Bearer OLD', 'Bearer A2']);
    expect(starts[0]!.init.headers['idempotency-key']).toBe(starts[1]!.init.headers['idempotency-key']);
    expect(JSON.parse(starts[0]!.init.body!)).toEqual({
      firstName: 'Asha', lastName: 'Rao', dob: '1990-01-31', pan: PAN, aadhaarLast4: '2346', deviceResult: 'pre-verified',
    });
    expect(f.calls.filter((x) => x.url.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(t.access).toBe('A2');
  });

  it('a second 401 after refresh does not loop: throws unauthorized and clears the token', async () => {
    const t = memTokens('OLD');
    const f = fakeFetch({
      'GET /kyc/status': [{ status: 401, body: { error: 'unauthorized' } }],
      'POST /auth/refresh': [{ status: 200, body: tokenBody(2, false) }],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t });
    await expect(c.getStatus()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(f.calls.filter((x) => x.url.endsWith('/kyc/status'))).toHaveLength(2);
    expect(f.calls.filter((x) => x.url.endsWith('/auth/refresh'))).toHaveLength(1);
    expect(t.access).toBeNull();
  });

  it('refresh rejected (401) ends the session', async () => {
    const t = memTokens('OLD');
    const f = fakeFetch({
      'GET /kyc/status': [{ status: 401, body: { error: 'unauthorized' } }],
      'POST /auth/refresh': [{ status: 401, body: { error: 'invalid_token' } }],
    });
    await expect(new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t }).getStatus()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(t.access).toBeNull();
  });

  it('no access token: refreshes first (web reload with only the cookie)', async () => {
    const t = memTokens(null);
    const f = fakeFetch({
      'POST /auth/refresh': [{ status: 200, body: tokenBody(3, false) }],
      'GET /kyc/status': [{ status: 200, body: { status: null, path: null, reason: null, next: 'start', eligibleToInvest: false } }],
    });
    const v = await new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t }).getStatus();
    expect(v).toEqual({ status: null, reason: null, next: { type: 'start' } });
    expect(f.calls[0]!.url).toBe(`${BASE}/auth/refresh`);
    expect(f.calls[0]!.init.credentials).toBe('include');
    expect(f.calls[1]!.init.headers.authorization).toBe('Bearer A3');
  });

  it('custom refresh is used once and its token stored', async () => {
    const t = memTokens('OLD');
    let n = 0;
    const f = fakeFetch({ 'GET /kyc/status': [{ status: 401, body: { error: 'unauthorized' } }, { status: 200, body: statusBody({ status: 'verified', next: 'none' }) }] });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t, refresh: async () => `C${++n}` });
    await expect(c.getStatus()).resolves.toEqual({ status: 'verified', reason: 'in-progress', next: { type: 'none' } });
    expect(n).toBe(1);
    expect(t.access).toBe('C1');
  });

  it('concurrent 401s share one refresh', async () => {
    const t = memTokens('OLD');
    const f = fakeFetch({
      'GET /kyc/status': [{ status: 401, body: { error: 'unauthorized' } }, { status: 401, body: { error: 'unauthorized' } }, { status: 200, body: statusBody() }],
      'POST /auth/refresh': [{ status: 200, body: tokenBody(2, false) }],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t });
    await Promise.all([c.getStatus(), c.getStatus()]);
    expect(f.calls.filter((x) => x.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('auth routes never refresh on 401 (wrong OTP)', async () => {
    const f = fakeFetch({ 'POST /auth/otp/verify': [{ status: 401, body: { error: 'invalid_code', message: 'x', triesLeft: 2 } }] });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens('A1') });
    await expect(c.verifyOtp('c'.repeat(22), '000000')).rejects.toMatchObject({ code: 'invalid_code', triesLeft: 2 });
    expect(f.calls).toHaveLength(1);
  });
});

describe('ServerKycClient KYC steps', () => {
  it('startAadhaar returns the DigiLocker URL; OTP mode without a URL', async () => {
    const f = fakeFetch({
      'POST /kyc/aadhaar': [
        { status: 200, body: { redirectUrl: 'https://partner.test/digilocker?ref=1', challengeRef: 'aad-1', kyc: statusBody() } },
        { status: 200, body: { challengeRef: 'aad-2', kyc: statusBody() } },
      ],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens(), newKey });
    await expect(c.startAadhaar('digilocker', 'https://app.test/return')).resolves.toEqual({
      status: 'pre-verified', reason: 'in-progress', next: { type: 'digilocker', url: 'https://partner.test/digilocker?ref=1' },
    });
    await expect(c.startAadhaar('otp', 'https://app.test/return')).resolves.toMatchObject({ next: { type: 'aadhaar-otp' } });
    expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ mode: 'digilocker', returnUrl: 'https://app.test/return' });
    expect(f.calls[0]!.init.headers['idempotency-key']).not.toBe(f.calls[1]!.init.headers['idempotency-key']);
  });

  it('documentUploadUrls sends files and returns uploads by kind; submitSelfie posts the uploadId', async () => {
    const f = fakeFetch({
      'POST /kyc/documents': [{ status: 200, body: { uploads: [
        { kind: 'selfie', uploadId: 'selfie-x.jpg', method: 'PUT', url: 'https://s3.test/a', headers: { 'content-type': 'image/jpeg' }, expiresAt: 'T', maxBytes: 1 },
      ] } }],
      'POST /kyc/selfie': [{ status: 200, body: statusBody({ next: 'esign' }) }],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens(), newKey });
    const u = await c.documentUploadUrls([{ kind: 'selfie', contentType: 'image/jpeg', size: 1234 }]);
    expect(u).toEqual({ selfie: { uploadId: 'selfie-x.jpg', url: 'https://s3.test/a', headers: { 'content-type': 'image/jpeg' }, expiresAt: 'T' } });
    expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ files: [{ kind: 'selfie', contentType: 'image/jpeg', size: 1234 }] });
    expect(f.calls[0]!.init.headers['idempotency-key']).toBeUndefined();
    await expect(c.submitSelfie('selfie-x.jpg')).resolves.toMatchObject({ next: { type: 'esign' } });
    expect(f.calls[1]!.init.headers['idempotency-key']).toBeDefined();
  });

  it('startEsign returns the e-sign URL', async () => {
    const f = fakeFetch({ 'POST /kyc/esign': [{ status: 200, body: { redirectUrl: 'https://partner.test/esign', kyc: statusBody({ next: 'esign' }) } }] });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens(), newKey });
    await expect(c.startEsign('https://app.test/r')).resolves.toMatchObject({ next: { type: 'esign', url: 'https://partner.test/esign' } });
  });

  it('maps server next steps', () => {
    const n = (status: unknown, next: unknown) => toKycStatusView({ status, reason: null, next }).next.type;
    expect(n(null, 'start')).toBe('start');
    expect(n('pre-verified', 'aadhaar')).toBe('digilocker');
    expect(n('pre-verified', 'selfie')).toBe('documents');
    expect(n('pre-verified', 'pan-check')).toBe('wait');
    expect(n('under-review', 'wait')).toBe('wait');
    expect(n('verified', 'kra-upload')).toBe('none');
    expect(n('rejected', 'wait')).toBe('none');
    expect(toKycStatusView({ status: 'bogus' }).status).toBeNull();
  });
});

describe('ServerKycClient errors', () => {
  it('maps server codes to ServerError with fixed messages', async () => {
    const f = fakeFetch({
      'POST /kyc/start': [
        { status: 429, body: { error: 'limit_reached', message: 'whatever' } },
        { status: 409, body: { error: 'wrong_step' } },
        { status: 503 },
        { status: 500, body: '<html>' },
      ],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens(), newKey });
    const input = { firstName: 'A', lastName: 'B', dob: '1990-01-01', pan: PAN, aadhaarLast4: '2346', deviceStatus: 'pre-verified' as const };
    const e1 = await c.startKyc(input).catch((e) => e);
    expect(e1).toBeInstanceOf(ServerError);
    expect(e1).toMatchObject({ status: 429, code: 'limit_reached' });
    expect(e1.message).toMatch(/limit/);
    await expect(c.startKyc(input)).rejects.toMatchObject({ status: 409, code: 'wrong_step' });
    await expect(c.startKyc(input)).rejects.toMatchObject({ status: 503, code: 'internal' });
    await expect(c.startKyc(input)).rejects.toMatchObject({ status: 500, code: 'internal' });
  });

  it('network failure is ServerError network', async () => {
    const f = fakeFetch({ 'GET /kyc/status': ['network-error'] });
    await expect(new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens() }).getStatus()).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('error messages and codes never contain a PAN, Aadhaar, OTP code or token, even if the server echoes them', async () => {
    const leak = `${PAN} ${AADHAAR} 123456 A1`;
    const f = fakeFetch({
      'POST /kyc/start': [{ status: 400, body: { error: leak, message: leak } }],
      'POST /auth/otp/verify': [{ status: 400, body: { error: 'bad_request', message: leak } }],
      'POST /auth/otp/send': ['network-error'],
    });
    const c = new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens(), newKey });
    const errs = [
      await c.startKyc({ firstName: 'A', lastName: 'B', dob: '1990-01-01', pan: PAN, aadhaarLast4: '2346', deviceStatus: 'pre-verified' }).catch((e) => e),
      await c.verifyOtp('c'.repeat(22), '123456').catch((e) => e),
      await c.sendOtp('email', 'a@b.test').catch((e) => e),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(ServerError);
      const text = `${e.message} ${e.code} ${String(e)} ${JSON.stringify(e)}`;
      for (const secret of [PAN, AADHAAR, '2346', '123456', 'A1', 'a@b.test']) expect(text).not.toContain(secret);
    }
    expect(errs[0].code).toBe('internal');
  });
});

describe('HttpOtpProvider', () => {
  it('is a non-demo provider; email/sms go to the server', async () => {
    const f = fakeFetch({
      'POST /auth/otp/send': [{ status: 200, body: { challengeId: 'x'.repeat(22), expiresAt: 99 } }],
      'POST /auth/otp/verify': [{ status: 200, body: tokenBody(1, false) }],
    });
    const t = memTokens(null);
    const p = new HttpOtpProvider(new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: t }));
    expect([p.id, p.isDemo]).toEqual(['http', false]);
    await expect(p.send({ channel: 'sms', target: '9876543210' }, 0)).resolves.toEqual({ ok: true, requestId: 'x'.repeat(22), expiresAt: 99 });
    expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ kind: 'mobile', contact: '9876543210' });
    await expect(p.verify('x'.repeat(22), ' 123456 ', 0)).resolves.toEqual({ ok: true });
    expect(JSON.parse(f.calls[1]!.init.body!)).toEqual({ challengeId: 'x'.repeat(22), code: '123456' });
    expect(t.access).toBe('A1');
  });

  it('aadhaar channel is not supported', async () => {
    const p = new HttpOtpProvider(new ServerKycClient({ baseUrl: BASE, fetch: fakeFetch({}).fetch, tokens: memTokens() }));
    await expect(p.send({ channel: 'aadhaar', target: AADHAAR }, 0)).rejects.toThrow(/not supported/);
  });

  it('maps errors to OTP results', async () => {
    const f = fakeFetch({
      'POST /auth/otp/send': [{ status: 429, body: { error: 'rate_limited', retryAfterMs: 1000 } }, { status: 400, body: { error: 'bad_request' } }, 'network-error'],
      'POST /auth/otp/verify': [{ status: 401, body: { error: 'invalid_code', triesLeft: 2 } }, { status: 401, body: { error: 'invalid_code', triesLeft: 0 } }],
    });
    const p = new HttpOtpProvider(new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens: memTokens(null) }));
    const req = { channel: 'email' as const, target: 'a@b.test' };
    await expect(p.send(req, 0)).resolves.toMatchObject({ ok: false, reason: 'rate-limited' });
    await expect(p.send(req, 0)).resolves.toMatchObject({ ok: false, reason: 'invalid-target' });
    await expect(p.send(req, 0)).resolves.toMatchObject({ ok: false, reason: 'network' });
    await expect(p.verify('x'.repeat(22), '000000', 0)).resolves.toEqual({ ok: false, reason: 'wrong', message: 'Wrong code. 2 tries left.' });
    await expect(p.verify('x'.repeat(22), '000000', 0)).resolves.toMatchObject({ ok: false, reason: 'void' });
  });
});

describe('eligibility', () => {
  const view = (status: KycStatusView['status']): KycStatusView => ({ status, reason: null, next: { type: 'none' } });

  it('serverEligibleToInvest only for verified', () => {
    expect(serverEligibleToInvest(null)).toBe(false);
    expect(serverEligibleToInvest(view('verified'))).toBe(true);
    for (const s of ['pre-verified', 'under-review', 'rejected', null] as const) expect(serverEligibleToInvest(view(s))).toBe(false);
  });

  it('isEligibleToInvest: the server view overrides the device value', () => {
    const withKyc = (step: 'done' | 'check', status: KycStatusView['status']) => ({
      ...emptyData(),
      onboarding: { ...emptyOnboarding(), step, kyc: { ...emptyOnboarding().kyc, match: 'matched' as const, status } },
    });
    expect(isEligibleToInvest(withKyc('done', 'verified'))).toBe(true);
    expect(isEligibleToInvest(withKyc('done', 'verified'), null)).toBe(true);
    expect(isEligibleToInvest(withKyc('done', 'verified'), view('under-review'))).toBe(false);
    expect(isEligibleToInvest(withKyc('done', 'pre-verified'))).toBe(false);
    expect(isEligibleToInvest(withKyc('done', 'pre-verified'), view('verified'))).toBe(true);
    expect(isEligibleToInvest(withKyc('check', 'pre-verified'), view('verified'))).toBe(false);
  });

  it('feature id is registered', () => {
    expect(FEATURES.find((f) => f.id === 'kyc-final-status')?.name).toBe('Final KYC: server status in Settings');
  });
});
