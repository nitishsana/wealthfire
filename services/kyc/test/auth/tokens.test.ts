import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { decodeProtectedHeader } from 'jose';
import { FakeClock } from '../../src/lib/clock';
import { sha256 } from '../../src/lib/crypto';
import { AuthError } from '../../src/lib/errors';
import { memoryRepos } from '../../src/lib/repo';
import {
  ACCESS_TTL_MS, derToJose, FAMILY_TTL_MS, KmsTokenSigner, LocalTokenSigner, REFRESH_TTL_MS, signAccessToken, TokenService,
  verifyAccessToken,
} from '../../src/lib/tokens';

function svc() {
  const clock = new FakeClock();
  const repos = memoryRepos();
  const signer = new LocalTokenSigner('k1');
  return { clock, repos, signer, tokens: new TokenService({ sessions: repos.sessions, signer, clock }) };
}

describe('access JWT', () => {
  it('is ES256 with kid and verifies until 15 minutes', async () => {
    const { clock, signer } = svc();
    const { token, expiresAt } = await signAccessToken(signer, clock, 'u1', 'f1');
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: 'k1', typ: 'JWT' });
    expect(expiresAt).toBe(clock.now() + ACCESS_TTL_MS);
    expect(await verifyAccessToken(signer, clock, token)).toMatchObject({ sub: 'u1', sid: 'f1' });
    clock.advance(ACCESS_TTL_MS - 1000);
    await expect(verifyAccessToken(signer, clock, token)).resolves.toBeTruthy();
    clock.advance(1000);
    await expect(verifyAccessToken(signer, clock, token)).rejects.toBeInstanceOf(AuthError);
  });
  it('rejects other keys, tampering and junk', async () => {
    const { clock, signer } = svc();
    const { token } = await signAccessToken(signer, clock, 'u1', 'f1');
    await expect(verifyAccessToken(new LocalTokenSigner('k1'), clock, token)).rejects.toThrow(AuthError);
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'u2' })).toString('base64url');
    await expect(verifyAccessToken(signer, clock, `${h}.${forged}.${s}`)).rejects.toThrow(AuthError);
    await expect(verifyAccessToken(signer, clock, 'a.b.c')).rejects.toThrow(AuthError);
    await expect(verifyAccessToken(signer, clock, '')).rejects.toThrow(AuthError);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`;
    await expect(verifyAccessToken(signer, clock, none)).rejects.toThrow(AuthError);
  });
  it('error text never contains the token', async () => {
    const { clock, signer } = svc();
    const { token } = await signAccessToken(signer, clock, 'u1', 'f1');
    clock.advance(ACCESS_TTL_MS);
    const err = await verifyAccessToken(signer, clock, token).catch((e: Error) => e);
    expect(String(err) + (err as Error).stack).not.toContain(token);
  });
});

describe('derToJose', () => {
  it('matches the ieee-p1363 encoding for many signatures', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (let i = 0; i < 50; i++) {
      const data = Buffer.from(`m${i}`);
      const der = nodeSign('sha256', data, { key: privateKey, dsaEncoding: 'der' });
      const jose = derToJose(der);
      expect(jose).toHaveLength(64);
      // Verify the converted signature with node (p1363).
      expect(nodeVerify('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }, jose)).toBe(true);
    }
  });
  it('rejects malformed DER', () => {
    expect(() => derToJose(new Uint8Array([0x31, 0]))).toThrow();
    expect(() => derToJose(new Uint8Array([0x30, 5, 2, 1]))).toThrow();
  });
});

describe('KmsTokenSigner', () => {
  it('signs via KMS Sign ECDSA_SHA_256 and verifies with GetPublicKey', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    let getKeyCalls = 0;
    const kms = {
      send: async (cmd: unknown) => {
        if (cmd instanceof SignCommand) {
          expect(cmd.input).toMatchObject({ KeyId: 'arn:key', MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' });
          return { Signature: new Uint8Array(nodeSign('sha256', cmd.input.Message!, { key: privateKey, dsaEncoding: 'der' })) };
        }
        if (cmd instanceof GetPublicKeyCommand) {
          getKeyCalls++;
          return { PublicKey: new Uint8Array(publicKey.export({ format: 'der', type: 'spki' })) };
        }
        throw new Error('unexpected');
      },
    };
    const clock = new FakeClock();
    const signer = new KmsTokenSigner(kms as never, 'arn:key', 'jwt-1');
    const { token } = await signAccessToken(signer, clock, 'u1', 'f1');
    expect(decodeProtectedHeader(token).kid).toBe('jwt-1');
    expect((await verifyAccessToken(signer, clock, token)).sub).toBe('u1');
    await verifyAccessToken(signer, clock, token);
    expect(getKeyCalls).toBe(1);
    const pem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const withKey = new KmsTokenSigner(kms as never, 'arn:key', 'jwt-1', pem);
    expect((await verifyAccessToken(withKey, clock, token)).sid).toBe('f1');
    expect(getKeyCalls).toBe(1);
  });
});

describe('TokenService', () => {
  it('issues a pair; refresh token stored only as sha256', async () => {
    const { tokens, repos, clock } = svc();
    const t = await tokens.issue('u1', 'web');
    expect(t.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.refreshExpiresAt).toBe(clock.now() + REFRESH_TTL_MS);
    expect(repos.sessions.storedKeys()).toEqual([sha256(t.refreshToken)]);
    expect((await tokens.authenticate(t.accessToken)).sub).toBe('u1');
  });
  it('rotates on every use; new token works, old does not', async () => {
    const { tokens } = svc();
    const a = await tokens.issue('u1');
    const b = await tokens.refresh(a.refreshToken);
    expect(b.refreshToken).not.toBe(a.refreshToken);
    expect(b.userId).toBe('u1');
    const c = await tokens.refresh(b.refreshToken);
    expect(c.userId).toBe('u1');
  });
  it('reuse of an old token revokes the whole family', async () => {
    const { tokens, repos } = svc();
    const a = await tokens.issue('u1');
    const b = await tokens.refresh(a.refreshToken);
    await expect(tokens.refresh(a.refreshToken)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens.refresh(b.refreshToken)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens.authenticate(b.accessToken)).rejects.toMatchObject({ code: 'unauthorized' });
    const fam = await repos.sessions.getFamily((await repos.sessions.getSession(sha256(a.refreshToken)))!.familyId);
    expect(fam?.revokedReason).toBe('reuse');
  });
  it('concurrent use of one token: one wins, family revoked', async () => {
    const { tokens } = svc();
    const a = await tokens.issue('u1');
    const results = await Promise.allSettled([tokens.refresh(a.refreshToken), tokens.refresh(a.refreshToken)]);
    expect(results.filter((r) => r.status === 'rejected').length).toBeGreaterThanOrEqual(1);
    const won = results.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof tokens.refresh>>> => r.status === 'fulfilled');
    if (won) await expect(tokens.refresh(won.value.refreshToken)).rejects.toThrow(AuthError);
  });
  it('other families are untouched by reuse', async () => {
    const { tokens } = svc();
    const a = await tokens.issue('u1');
    const other = await tokens.issue('u1');
    await tokens.refresh(a.refreshToken);
    await expect(tokens.refresh(a.refreshToken)).rejects.toThrow();
    await expect(tokens.refresh(other.refreshToken)).resolves.toBeTruthy();
  });
  it('refresh tokens expire after 30 idle days and families after 90 days', async () => {
    const { tokens, clock } = svc();
    const a = await tokens.issue('u1');
    clock.advance(REFRESH_TTL_MS);
    await expect(tokens.refresh(a.refreshToken)).rejects.toMatchObject({ code: 'invalid_token' });

    let t = await tokens.issue('u2');
    for (let elapsed = 0; elapsed + 20 * 86_400_000 < FAMILY_TTL_MS; elapsed += 20 * 86_400_000) {
      clock.advance(20 * 86_400_000);
      t = await tokens.refresh(t.refreshToken);
    }
    expect(t.refreshExpiresAt).toBeLessThanOrEqual(clock.now() + REFRESH_TTL_MS);
    clock.advance(t.refreshExpiresAt - clock.now());
    await expect(tokens.refresh(t.refreshToken)).rejects.toMatchObject({ code: 'invalid_token' });
  });
  it('logout revokes the family; unknown or junk tokens are ignored', async () => {
    const { tokens } = svc();
    const a = await tokens.issue('u1');
    await tokens.revoke(a.refreshToken);
    await expect(tokens.refresh(a.refreshToken)).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens.authenticate(a.accessToken)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(tokens.revoke('x'.repeat(43))).resolves.toBeUndefined();
    await expect(tokens.revoke('junk')).resolves.toBeUndefined();
  });
  it('rejects malformed refresh tokens without lookups', async () => {
    const { tokens } = svc();
    await expect(tokens.refresh('short')).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(tokens.refresh(undefined as never)).rejects.toMatchObject({ code: 'invalid_token' });
  });
});
