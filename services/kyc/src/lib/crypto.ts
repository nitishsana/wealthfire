// Crypto helpers: keyed lookup hashes (HMAC), argon2id secret hashing, envelope encryption,
// random tokens. Production keys live in KMS; tests use local keys. Nothing here logs.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { DecryptCommand, GenerateDataKeyCommand, GenerateMacCommand, type KMSClient } from '@aws-sdk/client-kms';

// ---------- Encoding ----------

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

/** `n` cryptographically random bytes as base64url (default 32 bytes = 256 bits). */
export function randomToken(n = 32): string {
  return toBase64Url(randomBytes(n));
}

/** SHA-256 of a high-entropy secret (e.g. a refresh token) as base64url. Not for low-entropy secrets. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- Keyed lookup hash (HMAC-SHA256) ----------

/** Produces an HMAC-SHA256 over data. Prod: KMS GenerateMac; tests: a local key. */
export interface MacSigner {
  mac(data: Uint8Array): Promise<Uint8Array>;
}

export class LocalMacSigner implements MacSigner {
  private readonly key: Buffer;

  constructor(key: Uint8Array = randomBytes(32)) {
    if (key.length < 32) throw new Error('HMAC key must be at least 32 bytes');
    this.key = Buffer.from(key);
  }

  async mac(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHmac('sha256', this.key).update(data).digest());
  }
}

export class KmsMacSigner implements MacSigner {
  constructor(private readonly kms: Pick<KMSClient, 'send'>, private readonly keyId: string) {}

  async mac(data: Uint8Array): Promise<Uint8Array> {
    const out = await this.kms.send(new GenerateMacCommand({ KeyId: this.keyId, MacAlgorithm: 'HMAC_SHA_256', Message: data }));
    if (!out.Mac) throw new Error('KMS GenerateMac returned no MAC');
    return out.Mac;
  }
}

/**
 * Deterministic keyed lookup key for a sensitive value (contact, PAN, IP).
 * `purpose` separates domains so the same value hashes differently per use.
 * Callers normalise the value first.
 */
export async function hmacLookup(signer: MacSigner, purpose: string, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${purpose}\u0000${value}`);
  return toBase64Url(await signer.mac(data));
}

// ---------- argon2id (low-entropy secrets: OTP codes) ----------

export interface Argon2Params {
  /** KiB */
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

/** OWASP 2024 minimum for argon2id: m = 19 MiB, t = 2, p = 1. */
export const ARGON2_DEFAULTS: Argon2Params = { memorySize: 19_456, iterations: 2, parallelism: 1, hashLength: 32 };

export interface SecretHasher {
  hash(secret: string): Promise<string>;
  verify(encodedHash: string, secret: string): Promise<boolean>;
}

/** argon2id via hash-wasm. Output is the PHC-encoded string (params + salt + hash). */
export class Argon2Hasher implements SecretHasher {
  constructor(private readonly params: Argon2Params = ARGON2_DEFAULTS) {}

  async hash(secret: string): Promise<string> {
    return argon2id({ password: secret, salt: randomBytes(16), outputType: 'encoded', ...this.params });
  }

  async verify(encodedHash: string, secret: string): Promise<boolean> {
    try {
      return await argon2Verify({ password: secret, hash: encodedHash });
    } catch {
      return false;
    }
  }
}

// ---------- Envelope encryption (AES-256-GCM) ----------

/** Encrypts small values (contact, PAN). `context` is bound as AAD / KMS encryption context. */
export interface Encryptor {
  encrypt(plaintext: string, context: Record<string, string>): Promise<string>;
  decrypt(ciphertext: string, context: Record<string, string>): Promise<string>;
}

function aad(context: Record<string, string>): Buffer {
  const keys = Object.keys(context).sort();
  return Buffer.from(JSON.stringify(keys.map((k) => [k, context[k]])), 'utf8');
}

function gcmSeal(key: Uint8Array, plaintext: string, context: Record<string, string>): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(context));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmOpen(key: Uint8Array, iv: Uint8Array, ct: Uint8Array, tag: Uint8Array, context: Record<string, string>): string {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad(context));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** Local AES-256-GCM with a fixed key. Format: `l1.<iv>.<ct>.<tag>`. Tests and local preview only. */
export class LocalEncryptor implements Encryptor {
  private readonly key: Buffer;

  constructor(key: Uint8Array = randomBytes(32)) {
    if (key.length !== 32) throw new Error('AES-256 key must be 32 bytes');
    this.key = Buffer.from(key);
  }

  async encrypt(plaintext: string, context: Record<string, string>): Promise<string> {
    const { iv, ct, tag } = gcmSeal(this.key, plaintext, context);
    return ['l1', iv, ct, tag].map((p) => (typeof p === 'string' ? p : toBase64Url(p))).join('.');
  }

  async decrypt(ciphertext: string, context: Record<string, string>): Promise<string> {
    const [v, iv, ct, tag] = ciphertext.split('.');
    if (v !== 'l1' || !iv || ct === undefined || !tag) throw new Error('Bad ciphertext');
    return gcmOpen(this.key, fromBase64Url(iv), fromBase64Url(ct), fromBase64Url(tag), context);
  }
}

/**
 * KMS envelope encryption: a fresh data key per record (GenerateDataKey AES_256), value sealed
 * locally with AES-256-GCM, wrapped key stored alongside. Format: `k1.<wrappedKey>.<iv>.<ct>.<tag>`.
 */
export class KmsEnvelopeEncryptor implements Encryptor {
  constructor(private readonly kms: Pick<KMSClient, 'send'>, private readonly keyId: string) {}

  async encrypt(plaintext: string, context: Record<string, string>): Promise<string> {
    const dk = await this.kms.send(new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: 'AES_256', EncryptionContext: context }));
    if (!dk.Plaintext || !dk.CiphertextBlob) throw new Error('KMS GenerateDataKey returned no key');
    const key = Buffer.from(dk.Plaintext);
    try {
      const { iv, ct, tag } = gcmSeal(key, plaintext, context);
      return ['k1', toBase64Url(dk.CiphertextBlob), toBase64Url(iv), toBase64Url(ct), toBase64Url(tag)].join('.');
    } finally {
      key.fill(0);
    }
  }

  async decrypt(ciphertext: string, context: Record<string, string>): Promise<string> {
    const [v, wrapped, iv, ct, tag] = ciphertext.split('.');
    if (v !== 'k1' || !wrapped || !iv || ct === undefined || !tag) throw new Error('Bad ciphertext');
    const out = await this.kms.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: fromBase64Url(wrapped), EncryptionContext: context }));
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no key');
    const key = Buffer.from(out.Plaintext);
    try {
      return gcmOpen(key, fromBase64Url(iv), fromBase64Url(ct), fromBase64Url(tag), context);
    } finally {
      key.fill(0);
    }
  }
}
