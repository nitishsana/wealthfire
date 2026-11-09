// Access tokens (15-minute ES256 JWT, signed by KMS in prod) and rotating refresh tokens.
// Refresh tokens are random 256-bit values stored only as sha256; every use rotates the token,
// and presenting an already-rotated token revokes the whole family (reuse detection).
// Nothing here logs; errors are AuthError with fixed messages.
import { createPublicKey, generateKeyPairSync, randomUUID, sign as nodeSign, type KeyObject } from 'node:crypto';
import { GetPublicKeyCommand, SignCommand, type KMSClient } from '@aws-sdk/client-kms';
import { errors as joseErrors, jwtVerify } from 'jose';
import type { Clock } from './clock';
import { randomToken, sha256, toBase64Url } from './crypto';
import { AuthError } from './errors';
import type { SessionRecord, SessionRepo, TokenFamily } from './repo';

export const ACCESS_TTL_MS = 15 * 60_000;
/** A refresh token unused for this long expires. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** Absolute end of a login (token family), however often it is refreshed. */
export const FAMILY_TTL_MS = 90 * 24 * 60 * 60_000;
export const TOKEN_ISSUER = 'wealthfire-kyc';
export const TOKEN_AUDIENCE = 'wealthfire-app';

// ---------- Signers ----------

/** Signs JWS input with ES256. `sign` returns the JOSE (r || s, 64 bytes) signature. */
export interface TokenSigner {
  readonly kid: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
  publicKey(): Promise<KeyObject>;
}

/** Local P-256 key (tests, local preview). */
export class LocalTokenSigner implements TokenSigner {
  readonly kid: string;
  private readonly priv: KeyObject;
  private readonly pub: KeyObject;

  constructor(kid = 'local') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.kid = kid;
    this.priv = privateKey;
    this.pub = publicKey;
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(nodeSign('sha256', data, { key: this.priv, dsaEncoding: 'ieee-p1363' }));
  }

  async publicKey(): Promise<KeyObject> {
    return this.pub;
  }
}

/** Converts a DER ECDSA signature (KMS output) to JOSE r || s. */
export function derToJose(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const byte = (): number => {
    const b = der[i++];
    if (b === undefined) throw new Error('Bad DER signature');
    return b;
  };
  const length = (): number => {
    let len = byte();
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2) throw new Error('Bad DER signature');
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | byte();
    }
    return len;
  };
  const int = (): Uint8Array => {
    if (byte() !== 0x02) throw new Error('Bad DER signature');
    const len = length();
    let v = der.slice(i, i + len);
    if (v.length !== len) throw new Error('Bad DER signature');
    i += len;
    while (v.length > size && v[0] === 0) v = v.slice(1);
    if (v.length > size) throw new Error('Bad DER signature');
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  if (byte() !== 0x30) throw new Error('Bad DER signature');
  const seqLen = length();
  if (seqLen !== der.length - i) throw new Error('Bad DER signature');
  const r = int();
  const s = int();
  if (i !== der.length) throw new Error('Bad DER signature');
  const out = new Uint8Array(size * 2);
  out.set(r, 0);
  out.set(s, size);
  return out;
}

/**
 * KMS asymmetric key (ECC_NIST_P256, SIGN_VERIFY). Signs with KMS Sign (ECDSA_SHA_256); verifies
 * locally with the public key (passed in as SPKI DER/PEM, or fetched once with GetPublicKey).
 */
export class KmsTokenSigner implements TokenSigner {
  private pub: Promise<KeyObject> | null;

  constructor(
    private readonly kms: Pick<KMSClient, 'send'>,
    private readonly keyId: string,
    readonly kid: string = keyId,
    publicKey?: KeyObject | string | Uint8Array,
  ) {
    this.pub = publicKey === undefined ? null : Promise.resolve(toKeyObject(publicKey));
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const out = await this.kms.send(
      new SignCommand({ KeyId: this.keyId, Message: data, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' }),
    );
    if (!out.Signature) throw new Error('KMS Sign returned no signature');
    return derToJose(out.Signature);
  }

  publicKey(): Promise<KeyObject> {
    if (!this.pub) {
      this.pub = this.kms.send(new GetPublicKeyCommand({ KeyId: this.keyId })).then((out) => {
        if (!out.PublicKey) throw new Error('KMS GetPublicKey returned no key');
        return toKeyObject(out.PublicKey);
      });
      this.pub.catch(() => {
        this.pub = null; // retry on the next call
      });
    }
    return this.pub;
  }
}

function toKeyObject(k: KeyObject | string | Uint8Array): KeyObject {
  if (typeof k === 'string') return createPublicKey(k);
  if (k instanceof Uint8Array) return createPublicKey({ key: Buffer.from(k), format: 'der', type: 'spki' });
  return k;
}

// ---------- Access JWT ----------

export interface AccessClaims {
  /** userId */
  sub: string;
  /** token family (login) id */
  sid: string;
  iat: number;
  exp: number;
  jti: string;
}

const enc = (o: unknown): string => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));

export async function signAccessToken(
  signer: TokenSigner,
  clock: Clock,
  userId: string,
  familyId: string,
  ttlMs: number = ACCESS_TTL_MS,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(clock.now() / 1000);
  const exp = iat + Math.floor(ttlMs / 1000);
  const header = enc({ alg: 'ES256', typ: 'JWT', kid: signer.kid });
  const payload = enc({ iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, sub: userId, sid: familyId, iat, exp, jti: randomUUID() });
  const input = `${header}.${payload}`;
  const sig = await signer.sign(new TextEncoder().encode(input));
  return { token: `${input}.${toBase64Url(sig)}`, expiresAt: exp * 1000 };
}

/** Verifies signature, alg, issuer, audience and expiry (against the injected clock). */
export async function verifyAccessToken(signer: TokenSigner, clock: Clock, token: string): Promise<AccessClaims> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) throw new AuthError('unauthorized');
  try {
    const { payload } = await jwtVerify(token, await signer.publicKey(), {
      algorithms: ['ES256'],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      currentDate: new Date(clock.now()),
      requiredClaims: ['sub', 'sid', 'exp', 'iat', 'jti'],
    });
    const { sub, sid, iat, exp, jti } = payload;
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof jti !== 'string') throw new AuthError('unauthorized');
    if (typeof iat !== 'number' || typeof exp !== 'number') throw new AuthError('unauthorized');
    return { sub, sid, iat, exp, jti };
  } catch (e) {
    if (e instanceof AuthError || e instanceof joseErrors.JOSEError) throw new AuthError('unauthorized');
    throw new AuthError('unauthorized');
  }
}

// ---------- Token service ----------

export interface TokenPair {
  userId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
}

export interface TokenServiceDeps {
  sessions: SessionRepo;
  signer: TokenSigner;
  clock: Clock;
}

export class TokenService {
  constructor(private readonly deps: TokenServiceDeps) {}

  /** Starts a new login (token family) for the user. */
  async issue(userId: string, device?: string): Promise<TokenPair> {
    const now = this.deps.clock.now();
    const family: TokenFamily = { familyId: randomUUID(), userId, createdAt: now, expiresAt: now + FAMILY_TTL_MS };
    await this.deps.sessions.putFamily(family);
    return this.mint(family, device);
  }

  /** Rotates a refresh token. Reusing an already-rotated token revokes the family. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { sessions, clock } = this.deps;
    if (!isTokenShape(refreshToken)) throw new AuthError('invalid_token');
    const now = clock.now();
    const s = await sessions.getSession(sha256(refreshToken));
    if (!s) throw new AuthError('invalid_token');
    if (s.usedAt !== undefined) {
      await sessions.revokeFamily(s.familyId, now, 'reuse');
      throw new AuthError('invalid_token');
    }
    const family = await sessions.getFamily(s.familyId);
    if (!family || family.revokedAt !== undefined || family.userId !== s.userId || now >= family.expiresAt || now >= s.expiresAt) {
      throw new AuthError('invalid_token');
    }
    if (!(await sessions.markUsed(s.tokenHash, now))) {
      // Lost a race with another use of the same token: treat as reuse.
      await sessions.revokeFamily(s.familyId, now, 'reuse');
      throw new AuthError('invalid_token');
    }
    return this.mint(family, s.device);
  }

  /** Ends the login the refresh token belongs to. Unknown tokens are ignored. */
  async revoke(refreshToken: string): Promise<void> {
    if (!isTokenShape(refreshToken)) return;
    const s = await this.deps.sessions.getSession(sha256(refreshToken));
    if (s) await this.deps.sessions.revokeFamily(s.familyId, this.deps.clock.now(), 'logout');
  }

  /** Verifies an access token and checks its login has not been revoked. */
  async authenticate(accessToken: string): Promise<AccessClaims> {
    const claims = await verifyAccessToken(this.deps.signer, this.deps.clock, accessToken);
    const family = await this.deps.sessions.getFamily(claims.sid);
    if (!family || family.revokedAt !== undefined || family.userId !== claims.sub) throw new AuthError('unauthorized');
    return claims;
  }

  private async mint(family: TokenFamily, device?: string): Promise<TokenPair> {
    const now = this.deps.clock.now();
    const refreshToken = randomToken(32);
    const session: SessionRecord = {
      tokenHash: sha256(refreshToken),
      userId: family.userId,
      familyId: family.familyId,
      createdAt: now,
      expiresAt: Math.min(now + REFRESH_TTL_MS, family.expiresAt),
      ...(device ? { device } : {}),
    };
    await this.deps.sessions.putSession(session);
    const access = await signAccessToken(this.deps.signer, this.deps.clock, family.userId, family.familyId);
    return {
      userId: family.userId,
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken,
      refreshExpiresAt: session.expiresAt,
    };
  }
}

/** randomToken(32) is 43 base64url chars. */
function isTokenShape(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);
}
