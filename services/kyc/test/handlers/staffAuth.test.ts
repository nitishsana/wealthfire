// S8: the review console sends `Authorization: Bearer <Cognito ID token>`; the router's staff
// check (CognitoStaffVerifier, the verifier the api Lambda builds) accepts exactly that.
// Tokens here are real RS256 JWTs shaped like Cognito's, checked against a local JWKS.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

type CryptoKey = webcrypto.CryptoKey;
import { MemoryLogger } from '../../src/kyc/log';
import { CognitoStaffVerifier } from '../../src/kyc/staff';
import { createRouter, type HttpRequest } from '../../src/router';
import { setup as authSetup } from '../auth/helpers';
import { makeCase, setup as reviewSetup } from '../review/fakes';

const REGION = 'ap-south-1';
const POOL = 'ap-south-1_TestPool1';
const CLIENT = 'console-client-id-123';
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

/** A Cognito-style ID token (token_use id, aud = app client, cognito:groups). */
async function idToken(over: { groups?: string[]; aud?: string; iss?: string; exp?: number; key?: CryptoKey; use?: string } = {}) {
  return new SignJWT({
    token_use: over.use ?? 'id',
    'cognito:groups': over.groups ?? ['reviewer'],
    'cognito:username': 'reviewer-1',
    email: 'reviewer@example.com',
    auth_time: Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('0b1c2d3e-0000-4000-8000-000000000001')
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(over.key ?? privateKey);
}

function router() {
  const a = authSetup();
  const r = reviewSetup();
  r.cases.put(makeCase());
  return createRouter({
    auth: { otp: a.otp, tokens: a.tokens, clock: a.clock },
    tokens: a.tokens,
    kyc: {},
    review: r.routes,
    staff: new CognitoStaffVerifier(REGION, POOL, CLIENT, jwks),
    allowedOrigins: [],
    logger: new MemoryLogger(),
    clock: a.clock,
  } as Parameters<typeof createRouter>[0]);
}

const get = (headers: Record<string, string>): HttpRequest => ({ method: 'GET', path: '/review/cases', headers, query: {}, ip: '198.51.100.9' });

describe('S8: staff Authorization header', () => {
  it('Authorization: Bearer <Cognito ID token> of a reviewer -> 200 (any header case)', async () => {
    const r = router();
    const token = await idToken();
    expect((await r(get({ Authorization: `Bearer ${token}` }))).statusCode).toBe(200);
    expect((await r(get({ authorization: `Bearer ${token}` }))).statusCode).toBe(200);
    const list = JSON.parse((await r(get({ authorization: `Bearer ${token}` }))).body);
    expect(list.items).toHaveLength(1);
  });

  it('the raw token without "Bearer" (the old console format) -> 401', async () => {
    const r = router();
    const res = await r(get({ Authorization: await idToken() }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('unauthorized');
  });

  it('a Cognito access token for the same client is accepted too', async () => {
    const r = router();
    const access = await new SignJWT({ token_use: 'access', client_id: CLIENT, 'cognito:groups': ['reviewer'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setSubject('s-2').setIssuer(ISSUER).setIssuedAt().setExpirationTime('1h')
      .sign(privateKey);
    expect((await r(get({ Authorization: `Bearer ${access}` }))).statusCode).toBe(200);
  });

  it('a signed-in staff member outside the reviewer group -> 403', async () => {
    const r = router();
    expect((await r(get({ Authorization: `Bearer ${await idToken({ groups: ['viewer'] })}` }))).statusCode).toBe(403);
  });

  it.each([
    ['another app client', { aud: 'other-client' }],
    ['another pool', { iss: `https://cognito-idp.${REGION}.amazonaws.com/ap-south-1_Other` }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['a token signed by another key', { key: undefined as unknown as CryptoKey, other: true }],
    ['an unknown token_use', { use: 'refresh' }],
  ])('%s -> 401', async (_label, over) => {
    const r = router();
    const token = await idToken('other' in over ? { key: otherKey } : over);
    expect((await r(get({ Authorization: `Bearer ${token}` }))).statusCode).toBe(401);
  });

  it('other schemes or junk -> 401', async () => {
    const r = router();
    const token = await idToken();
    for (const h of [`Basic ${token}`, `Bearer`, `Bearer  `, `Bearer ${token} extra`, 'Bearer not-a-jwt-but-long-enough']) {
      expect((await r(get({ Authorization: h }))).statusCode, h).toBe(401);
    }
  });
});
