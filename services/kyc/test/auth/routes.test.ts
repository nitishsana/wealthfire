import { describe, expect, it } from 'vitest';
import {
  AUTH_ROUTES, errorResponse, handleLogout, handleOtpSend, handleOtpVerify, handleRefresh, REFRESH_COOKIE, type RouteRequest,
} from '../../src/auth/routes';
import { EMAIL, MOBILE, setup } from './helpers';

const IP = '203.0.113.9';
const req = (body: unknown, headers: Record<string, string> = {}): RouteRequest => ({ body, headers, ip: IP });
const web = { 'X-WF-Client': 'web' };

function env() {
  const s = setup();
  return { ...s, deps: { otp: s.otp, tokens: s.tokens, clock: s.clock } };
}

async function signIn(e: ReturnType<typeof env>, headers: Record<string, string> = {}) {
  const sent = await handleOtpSend(req({ kind: 'mobile', contact: MOBILE }), e.deps);
  expect(sent.status).toBe(200);
  return handleOtpVerify(req({ challengeId: sent.body.challengeId, code: e.sender.lastCode }, headers), e.deps);
}

describe('auth routes', () => {
  it('registers the four routes', () => {
    expect(Object.keys(AUTH_ROUTES).sort()).toEqual(
      ['POST /auth/logout', 'POST /auth/otp/send', 'POST /auth/otp/verify', 'POST /auth/refresh'],
    );
  });

  it('send: 200 with only challenge info; accepts a JSON string body', async () => {
    const { deps, sender } = env();
    const r = await handleOtpSend(req(JSON.stringify({ kind: 'email', contact: EMAIL })), deps);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['challengeId', 'expiresAt', 'resendAt']);
    expect(JSON.stringify(r)).not.toContain(sender.lastCode!);
    expect(JSON.stringify(r).toLowerCase()).not.toContain('asha');
  });

  it('send: 400 on bad input, 429 with retryAfterMs on cooldown', async () => {
    const { deps } = env();
    for (const b of [{ kind: 'email', contact: 'bad' }, { kind: 'x' }, '{not json', [1], 'x'.repeat(5000)]) {
      const r = await handleOtpSend(req(b), deps);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('bad_request');
    }
    await handleOtpSend(req({ kind: 'email', contact: EMAIL }), deps);
    const r = await handleOtpSend(req({ kind: 'email', contact: EMAIL }), deps);
    expect(r.status).toBe(429);
    expect(r.body.retryAfterMs).toBe(30_000);
  });

  it('verify (phone): 200 with tokens in body, no cookie', async () => {
    const e = env();
    const r = await signIn(e);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ isNewUser: true });
    expect(typeof r.body.accessToken).toBe('string');
    expect(typeof r.body.refreshToken).toBe('string');
    expect(r.cookies).toBeUndefined();
  });

  it('verify (web): refresh token only in an HttpOnly Secure cookie', async () => {
    const e = env();
    const r = await signIn(e, web);
    expect(r.status).toBe(200);
    expect(r.body.refreshToken).toBeUndefined();
    const c = r.cookies![0]!;
    expect(c).toMatchObject({ name: REFRESH_COOKIE, httpOnly: true, secure: true, path: '/auth', sameSite: 'None' });
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.maxAge).toBe(30 * 86_400);
  });

  it('verify: 401 on wrong code with triesLeft, 400 on bad shape', async () => {
    const e = env();
    const sent = await handleOtpSend(req({ kind: 'email', contact: EMAIL }), e.deps);
    const wrong = e.sender.lastCode === '000000' ? '111111' : '000000';
    const r = await handleOtpVerify(req({ challengeId: sent.body.challengeId, code: wrong }), e.deps);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: 'invalid_code', triesLeft: 4 });
    expect((await handleOtpVerify(req({ challengeId: sent.body.challengeId, code: 'abc' }), e.deps)).status).toBe(400);
    expect((await handleOtpVerify(req(null), e.deps)).status).toBe(400);
  });

  it('refresh: body token rotates; reuse is 401', async () => {
    const e = env();
    const first = await signIn(e);
    const r = await handleRefresh(req({ refreshToken: first.body.refreshToken }), e.deps);
    expect(r.status).toBe(200);
    expect(r.body.refreshToken).not.toBe(first.body.refreshToken);
    const reuse = await handleRefresh(req({ refreshToken: first.body.refreshToken }), e.deps);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe('invalid_token');
    expect((await handleRefresh(req({ refreshToken: r.body.refreshToken }), e.deps)).status).toBe(401);
  });

  it('refresh (web): reads the cookie, sets a new one, clears it on failure', async () => {
    const e = env();
    const first = await signIn(e, web);
    const old = first.cookies![0]!.value;
    const r = await handleRefresh(req(undefined, { ...web, Cookie: `a=b; ${REFRESH_COOKIE}=${old}` }), e.deps);
    expect(r.status).toBe(200);
    expect(r.cookies![0]!.value).not.toBe(old);
    const bad = await handleRefresh(req('', { ...web, cookie: `${REFRESH_COOKIE}=${old}` }), e.deps);
    expect(bad.status).toBe(401);
    expect(bad.cookies![0]).toMatchObject({ value: '', maxAge: 0 });
  });

  it('refresh: 401 without a token', async () => {
    const { deps } = env();
    expect((await handleRefresh(req({}), deps)).status).toBe(401);
  });

  it('logout: 200 always, revokes the login, clears the web cookie', async () => {
    const e = env();
    const first = await signIn(e);
    expect((await handleLogout(req({ refreshToken: first.body.refreshToken }), e.deps)).status).toBe(200);
    expect((await handleRefresh(req({ refreshToken: first.body.refreshToken }), e.deps)).status).toBe(401);
    expect((await handleLogout(req({}), e.deps)).status).toBe(200);
    const w = await handleLogout(req({}, web), e.deps);
    expect(w.cookies![0]).toMatchObject({ value: '', maxAge: 0 });
  });

  it('unknown errors become a generic 500', () => {
    const r = errorResponse(new Error('boom 9876543210 123456'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r)).not.toMatch(/boom|9876543210|123456/);
  });

  it('no response or error text leaks codes, tokens or contacts', async () => {
    const e = env();
    const secrets: string[] = ['9876543210', 'asha.rao@example.com'];
    const bodies: string[] = [];
    const sent = await handleOtpSend(req({ kind: 'mobile', contact: MOBILE }), e.deps);
    const code = e.sender.lastCode!;
    secrets.push(code);
    const wrong = code === '000000' ? '111111' : '000000';
    bodies.push(JSON.stringify(await handleOtpVerify(req({ challengeId: sent.body.challengeId, code: wrong }), e.deps)));
    bodies.push(JSON.stringify(await handleOtpSend(req({ kind: 'mobile', contact: MOBILE }), e.deps))); // 429
    bodies.push(JSON.stringify(await handleOtpSend(req({ kind: 'email', contact: EMAIL.replace('@', '') }), e.deps))); // 400
    const ok = await handleOtpVerify(req({ challengeId: sent.body.challengeId, code }), e.deps);
    secrets.push(ok.body.refreshToken as string, ok.body.accessToken as string);
    bodies.push(JSON.stringify(await handleRefresh(req({ refreshToken: 'A'.repeat(43) }), e.deps)));
    await handleRefresh(req({ refreshToken: ok.body.refreshToken }), e.deps);
    bodies.push(JSON.stringify(await handleRefresh(req({ refreshToken: ok.body.refreshToken }), e.deps))); // reuse
    e.sender.fail = true;
    e.clock.advance(60_000);
    bodies.push(JSON.stringify(await handleOtpSend(req({ kind: 'email', contact: EMAIL }), e.deps))); // 503
    expect(bodies.map((b) => JSON.parse(b).status)).toEqual([401, 429, 400, 401, 401, 503]);
    for (const b of bodies) for (const s of secrets) expect(b).not.toContain(s);
  });
});
