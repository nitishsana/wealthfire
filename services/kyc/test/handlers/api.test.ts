import type { APIGatewayProxyEvent, APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { APP_RETURN_SCHEME, createHandler, createPartner, returnUrlPrefixes, toHttpRequest, toResult } from '../../src/handlers/api';
import { FakePartner } from '../../src/partner/fake';
import { createRouter, matchRoute, MAX_BODY_BYTES, serializeCookie, type HttpResponse } from '../../src/router';
import { MemoryLogger } from '../../src/kyc/log';
import { MOBILE } from '../auth/helpers';
import { env, ORIGIN, PANS, startBody } from '../kyc/helpers';

const v2 = (over: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: '/kyc/status',
  rawQueryString: '',
  headers: { authorization: 'Bearer x' },
  isBase64Encoded: false,
  requestContext: {
    accountId: '1', apiId: 'a', domainName: 'd', domainPrefix: 'd', requestId: 'r', routeKey: '$default', stage: '$default',
    time: '', timeEpoch: 0, http: { method: 'GET', path: '/kyc/status', protocol: 'HTTP/1.1', sourceIp: '198.51.100.1', userAgent: 'ua' },
  },
  ...over,
});

const v1 = (over: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: '/auth/refresh',
  headers: { Cookie: 'wf_refresh=abc' },
  multiValueHeaders: {},
  queryStringParameters: { limit: '5' },
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  resource: '/{proxy+}',
  body: Buffer.from('{"a":1}').toString('base64'),
  isBase64Encoded: true,
  requestContext: { identity: { sourceIp: '192.0.2.4' } } as APIGatewayProxyEvent['requestContext'],
  ...over,
});

describe('router: auth wiring', () => {
  it('/kyc/* needs a valid, unrevoked access token', async () => {
    const e = env();
    expect((await e.call('GET', '/kyc/status')).statusCode).toBe(401);
    expect((await e.call('GET', '/kyc/status', { token: 'garbage' })).json).toMatchObject({ error: 'unauthorized' });
    expect((await e.call('GET', '/kyc/status', { headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
    // sign in, then log out: the access token stops working
    const sent = await e.call('POST', '/auth/otp/send', { body: { kind: 'mobile', contact: MOBILE } });
    const v = await e.call('POST', '/auth/otp/verify', { body: { challengeId: sent.json.challengeId, code: e.sender.lastCode } });
    expect((await e.call('GET', '/kyc/status', { token: v.json.accessToken })).statusCode).toBe(200);
    await e.call('POST', '/auth/logout', { body: { refreshToken: v.json.refreshToken } });
    expect((await e.call('GET', '/kyc/status', { token: v.json.accessToken })).statusCode).toBe(401);
  });

  it('a user only ever sees their own case', async () => {
    const e = env();
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.kraValidated) });
    expect((await e.call('GET', '/kyc/status', { token: t2 })).json.status).toBeNull();
  });

  it('/auth/* web client: refresh token set as an HttpOnly Secure cookie', async () => {
    const e = env();
    const sent = await e.call('POST', '/auth/otp/send', { body: { kind: 'mobile', contact: MOBILE } });
    const v = await e.call('POST', '/auth/otp/verify', {
      body: { challengeId: sent.json.challengeId, code: e.sender.lastCode }, headers: { 'x-wf-client': 'web' },
    });
    expect(v.statusCode).toBe(200);
    expect(v.json.refreshToken).toBeUndefined();
    expect(v.cookies[0]).toMatch(/^wf_refresh=[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/auth; HttpOnly; Secure; SameSite=None$/);
  });

  it('/review/* needs a staff token in group reviewer', async () => {
    const e = env();
    expect((await e.call('GET', '/review/cases')).statusCode).toBe(401);
    // an app user token is not a staff token
    const token = await e.signIn();
    expect((await e.call('GET', '/review/cases', { token })).statusCode).toBe(401);
    const viewer = await e.call('GET', '/review/cases', { headers: { authorization: 'Bearer staff-token-viewer-00001' } });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json.error).toBe('forbidden');
    const ok = await e.call('GET', '/review/cases', { headers: { authorization: 'Bearer staff-token-reviewer-0001' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json.items).toEqual([]);
    const missing = await e.call('GET', '/review/cases/nope', { headers: { authorization: 'Bearer staff-token-reviewer-0001' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('router: HTTP behaviour', () => {
  it('JSON + security headers; CORS only for allowed origins', async () => {
    const e = env();
    const r = await e.call('GET', '/kyc/status');
    expect(r.headers).toMatchObject({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-credentials': 'true',
    });
    const evil = await e.call('GET', '/kyc/status', { headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('OPTIONS preflight → 204; unknown route → 404; trailing slash ok; body too large → 413', async () => {
    const e = env();
    const pre = await e.call('OPTIONS', '/kyc/start');
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('idempotency-key');
    expect((await e.call('GET', '/nope')).statusCode).toBe(404);
    expect((await e.call('DELETE', '/kyc/status')).statusCode).toBe(404);
    const token = await e.signIn();
    expect((await e.call('GET', '/kyc/status/', { token })).statusCode).toBe(200);
    const big = await e.call('POST', '/kyc/start', { token, body: 'x'.repeat(MAX_BODY_BYTES + 1) });
    expect(big.statusCode).toBe(413);
  });

  it('an unexpected throw is a generic 500 and logs no message', async () => {
    const logger = new MemoryLogger();
    const e = env();
    const router = createRouter({
      auth: { otp: e.otp, tokens: e.tokens, clock: e.clock },
      tokens: e.tokens,
      kyc: { 'GET /kyc/status': async () => { throw new Error(`boom ${PANS.fullPass}`); } },
      review: {},
      staff: e.staff,
      allowedOrigins: [],
      logger,
      clock: e.clock,
    });
    const token = await e.signIn();
    const r = await router({ method: 'GET', path: '/kyc/status', headers: { authorization: `Bearer ${token}` }, query: {}, ip: '1' });
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toMatch(/boom|ABCPR/);
    expect(logger.lines.join()).not.toMatch(/boom|ABCPR/);
  });

  it('matchRoute handles {id} templates', () => {
    const keys = ['GET /review/cases', 'GET /review/cases/{id}', 'POST /review/cases/{id}'];
    expect(matchRoute(keys, 'GET', '/review/cases/abc-1')).toEqual({ key: 'GET /review/cases/{id}', params: { id: 'abc-1' } });
    expect(matchRoute(keys, 'POST', '/review/cases')).toBeNull();
    expect(matchRoute(keys, 'GET', '/review/cases/a/b')).toBeNull();
    expect(matchRoute(keys, 'GET', '/review/cases/%E0%A4%A')).toBeNull();
  });

  it('serializeCookie', () => {
    expect(serializeCookie({ name: 'a', value: 'b', httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: 0 }))
      .toBe('a=b; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict');
  });
});

describe('Lambda adapter (handlers/api.ts)', () => {
  it('maps HTTP API v2 events (stage prefix, cookies, source IP)', () => {
    const r = toHttpRequest(v2({
      rawPath: '/dev/kyc/start', cookies: ['a=1', 'wf_refresh=t'], body: '{}',
      requestContext: { ...v2().requestContext, stage: 'dev', http: { ...v2().requestContext.http, method: 'POST' } },
    }));
    expect(r).toMatchObject({ method: 'POST', path: '/kyc/start', body: '{}', ip: '198.51.100.1' });
    expect(r.headers.cookie).toBe('a=1; wf_refresh=t');
    expect(toHttpRequest(v2()).path).toBe('/kyc/status');
  });

  it('maps REST API v1 proxy events (base64 body, query, source IP)', () => {
    const r = toHttpRequest(v1());
    expect(r).toMatchObject({ method: 'POST', path: '/auth/refresh', body: '{"a":1}', ip: '192.0.2.4', query: { limit: '5' } });
    expect(r.headers.Cookie).toBe('wf_refresh=abc');
  });

  it('returns cookies as v2 cookies / v1 multiValueHeaders Set-Cookie', () => {
    const res: HttpResponse = { statusCode: 200, headers: { a: 'b' }, body: '{}', cookies: ['c=1'] };
    expect(toResult(v2(), res)).toEqual({ statusCode: 200, headers: { a: 'b' }, body: '{}', cookies: ['c=1'] });
    expect(toResult(v1(), res)).toEqual({ statusCode: 200, headers: { a: 'b' }, body: '{}', multiValueHeaders: { 'Set-Cookie': ['c=1'] } });
    expect(toResult(v1(), { ...res, cookies: [] })).not.toHaveProperty('multiValueHeaders');
  });

  it('createHandler: builds the router once; init failure → 503 not_configured', async () => {
    let built = 0;
    const h = createHandler(() => {
      built++;
      return async (req) => ({ statusCode: 200, headers: {}, body: JSON.stringify({ path: req.path }), cookies: [] });
    });
    expect(await h(v2())).toMatchObject({ statusCode: 200, body: '{"path":"/kyc/status"}' });
    await h(v2());
    expect(built).toBe(1);
    const bad = createHandler(() => {
      throw new Error('Missing env DATA_KEY_ID');
    });
    const r = (await bad(v1())) as { statusCode: number; body: string };
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).error).toBe('not_configured');
    expect(r.body).not.toContain('DATA_KEY_ID');
  });

  it('createPartner: FakePartner on dev only; prod refuses', () => {
    expect(createPartner({ STAGE: 'dev' })).toBeInstanceOf(FakePartner);
    expect(() => createPartner({ STAGE: 'prod' })).toThrow();
    expect(() => createPartner({ STAGE: 'prod', KYC_PARTNER: 'fake' })).toThrow();
    expect(() => createPartner({})).toThrow();
  });

  it('return URL prefixes come from ALLOWED_ORIGINS plus the app scheme', () => {
    expect(returnUrlPrefixes({ ALLOWED_ORIGINS: 'https://nitishsana.github.io, http://127.0.0.1:5180/' }))
      .toEqual(['https://nitishsana.github.io/', 'http://127.0.0.1:5180/', APP_RETURN_SCHEME]);
  });
});
