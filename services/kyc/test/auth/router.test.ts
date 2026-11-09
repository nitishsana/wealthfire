import { describe, expect, it } from 'vitest';
import { createRouter, CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, type DevPartnerHandler, type HttpRequest, type RouterDeps } from '../../src/router';
import { silentLogger } from '../../src/kyc/log';
import type { KycHandler } from '../../src/kyc/routes';
import { devPartnerRoutes } from '../../src/partner/devPages';
import { MOBILE, setup } from './helpers';

const ORIGIN = 'https://nitishsana.github.io';

function make(over: Partial<RouterDeps> = {}) {
  const s = setup();
  const seen: string[] = [];
  const kycHandler = (name: string): KycHandler => async (r) => {
    seen.push(`${name}:${r.userId}`);
    return { status: 200, body: { name } };
  };
  const router = createRouter({
    auth: { otp: s.otp, tokens: s.tokens, clock: s.clock },
    tokens: s.tokens,
    // whatever the kyc route map exports is registered, including routes the router never names
    kyc: { 'DELETE /kyc/data': kycHandler('delete'), 'POST /kyc/consent': kycHandler('consent'), 'POST /kyc/brand-new': kycHandler('new') },
    review: {},
    staff: { verify: async () => null },
    allowedOrigins: [ORIGIN],
    logger: silentLogger,
    clock: s.clock,
    ...over,
  });
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    router({ method, path, headers, query: {}, ip: '203.0.113.5', body: body === undefined ? undefined : JSON.stringify(body) } as HttpRequest);
  return { ...s, router, call, seen };
}

const page: DevPartnerHandler = async (r) => ({
  status: 200, body: `<!doctype html><title>Fake DigiLocker</title><p>${r.params.ref}</p>`, headers: { 'content-type': 'text/html; charset=utf-8' },
});
const json: DevPartnerHandler = async () => ({ status: 200, body: { ok: true } });
const devPartner = { 'GET /dev-partner/digilocker/{ref}': page, 'POST /dev-partner/digilocker/{ref}/done': json };

describe('router: CORS', () => {
  it('preflight allows DELETE and the x-wf-client header', async () => {
    const { call } = make();
    const r = await call('OPTIONS', '/kyc/data', { origin: ORIGIN });
    expect(r.statusCode).toBe(204);
    expect(CORS_ALLOW_METHODS).toBe('GET, POST, DELETE, OPTIONS');
    expect(r.headers['access-control-allow-methods']).toBe(CORS_ALLOW_METHODS);
    expect(r.headers['access-control-allow-headers']).toBe(CORS_ALLOW_HEADERS);
    for (const h of ['x-wf-client', 'idempotency-key', 'authorization', 'content-type']) expect(CORS_ALLOW_HEADERS).toContain(h);
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    const other = await call('OPTIONS', '/kyc/data', { origin: 'https://evil.example' });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('router: kyc route map', () => {
  it('registers every key of the kyc map as-is (auth required)', async () => {
    const e = make();
    const sent = await e.call('POST', '/auth/otp/send', {}, { kind: 'mobile', contact: MOBILE });
    const v = await e.call('POST', '/auth/otp/verify', {}, { challengeId: JSON.parse(sent.body).challengeId, code: e.sender.lastCode });
    const token = JSON.parse(v.body).accessToken as string;
    for (const [m, p, name] of [['DELETE', '/kyc/data', 'delete'], ['POST', '/kyc/consent', 'consent'], ['POST', '/kyc/brand-new', 'new']] as const) {
      expect((await e.call(m, p)).statusCode).toBe(401);
      const r = await e.call(m, p, { authorization: `Bearer ${token}` });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ name });
    }
    expect(e.seen).toHaveLength(3);
    // nothing outside the map is a kyc route
    expect((await e.call('GET', '/kyc/data', { authorization: `Bearer ${token}` })).statusCode).toBe(404);
  });
});

describe('router: dev partner pages (STAGE=dev only)', () => {
  it('serves them on dev, HTML passed through unchanged', async () => {
    const { call } = make({ stage: 'dev', devPartner });
    const r = await call('GET', '/dev-partner/digilocker/ref-1');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.body).toBe('<!doctype html><title>Fake DigiLocker</title><p>ref-1</p>');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const j = await call('POST', '/dev-partner/digilocker/ref-1/done');
    expect(j.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(j.body)).toEqual({ ok: true });
  });

  it('never registers them on any other stage', async () => {
    for (const stage of [undefined, 'prod', 'Dev', 'dev ', 'staging']) {
      const { call } = make({ stage, devPartner });
      expect((await call('GET', '/dev-partner/digilocker/ref-1')).statusCode, String(stage)).toBe(404);
      expect((await call('POST', '/dev-partner/digilocker/ref-1/done')).statusCode, String(stage)).toBe(404);
    }
  });

  it('registers the real devPartnerRoutes map on dev only', async () => {
    const map = devPartnerRoutes({ webhookSecret: async () => 's'.repeat(32), webhookUrl: 'https://api.invalid/webhooks/partner', clock: { now: () => 0 } });
    const dev = make({ stage: 'dev', devPartner: map });
    const r = await dev.call('GET', '/dev-partner/digilocker');
    expect(r.statusCode).toBe(400); // no link params: the page's own error, as HTML
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.body.startsWith('<!doctype html>')).toBe(true);
    const prod = make({ stage: 'prod', devPartner: map });
    for (const [m, p] of [['GET', '/dev-partner/digilocker'], ['POST', '/dev-partner/esign']] as const) {
      expect((await prod.call(m, p)).statusCode).toBe(404);
    }
  });

  it('a JSON route never answers a string body as HTML', async () => {
    const sneaky: DevPartnerHandler = async () => ({ status: 200, body: '<script>x</script>' });
    const { call } = make({ stage: 'dev', devPartner: { 'GET /dev-partner/x': sneaky } });
    const r = await call('GET', '/dev-partner/x');
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.body).toBe(JSON.stringify('<script>x</script>'));
  });
});

describe('router: refresh cookie (R2/S6, S4)', () => {
  async function webSignIn(e: ReturnType<typeof make>, headers: Record<string, string>) {
    const sent = await e.call('POST', '/auth/otp/send', {}, { kind: 'mobile', contact: MOBILE });
    return e.call('POST', '/auth/otp/verify', headers, { challengeId: JSON.parse(sent.body).challengeId, code: e.sender.lastCode });
  }

  it('web + allowed Origin: wf_rt cookie on Path=/, Partitioned, no refresh token in the body', async () => {
    const e = make();
    const v = await webSignIn(e, { 'x-wf-client': 'web', origin: ORIGIN });
    expect(v.statusCode).toBe(200);
    expect(v.cookies[0]).toMatch(/^wf_rt=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=None; Partitioned$/);
    expect(JSON.parse(v.body).refreshToken).toBeUndefined();
    const value = /^wf_rt=([^;]+)/.exec(v.cookies[0]!)![1]!;
    // the stage-prefixed path is stripped by the adapter; Path=/ matches /<stage>/auth/refresh in the browser
    const r = await e.call('POST', '/auth/refresh', { 'x-wf-client': 'web', origin: ORIGIN, cookie: `wf_rt=${value}` });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).refreshToken).toBeUndefined();
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('web from another Origin: 403, no cookie, no tokens', async () => {
    const e = make();
    const v = await webSignIn(e, { 'x-wf-client': 'web', origin: 'https://evil.example' });
    expect(v.statusCode).toBe(403);
    expect(v.cookies).toEqual([]);
    expect(v.body).not.toMatch(/Token/);
  });
});
