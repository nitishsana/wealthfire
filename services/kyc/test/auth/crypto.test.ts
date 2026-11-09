import { describe, expect, it } from 'vitest';
import { DecryptCommand, GenerateDataKeyCommand, GenerateMacCommand } from '@aws-sdk/client-kms';
import { createHmac, randomBytes } from 'node:crypto';
import {
  ARGON2_DEFAULTS, Argon2Hasher, fromBase64Url, hmacLookup, KmsEnvelopeEncryptor, KmsMacSigner, LocalEncryptor,
  LocalMacSigner, randomToken, safeEqual, sha256, toBase64Url,
} from '../../src/lib/crypto';
import { FAST_ARGON2 } from './helpers';

describe('encoding and tokens', () => {
  it('base64url round-trips', () => {
    const b = new Uint8Array([0, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    expect(toBase64Url(b)).not.toMatch(/[+/=]/);
  });
  it('randomToken is 256-bit base64url and unique', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(randomToken(16)).toHaveLength(22);
  });
  it('sha256 is deterministic', () => {
    expect(sha256('x')).toBe(sha256('x'));
    expect(sha256('x')).not.toBe(sha256('y'));
  });
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('hmacLookup', () => {
  it('is deterministic per key and separated by purpose', async () => {
    const key = randomBytes(32);
    const s = new LocalMacSigner(key);
    const a = await hmacLookup(s, 'contact', 'a@b.co');
    expect(await hmacLookup(s, 'contact', 'a@b.co')).toBe(a);
    expect(await hmacLookup(s, 'ip', 'a@b.co')).not.toBe(a);
    expect(await hmacLookup(new LocalMacSigner(), 'contact', 'a@b.co')).not.toBe(a);
    expect(a).not.toContain('a@b.co');
  });
  it('rejects short keys', () => {
    expect(() => new LocalMacSigner(new Uint8Array(16))).toThrow();
  });
  it('KmsMacSigner uses GenerateMac HMAC_SHA_256', async () => {
    const key = randomBytes(32);
    const kms = {
      send: async (cmd: unknown) => {
        expect(cmd).toBeInstanceOf(GenerateMacCommand);
        const input = (cmd as GenerateMacCommand).input;
        expect(input.MacAlgorithm).toBe('HMAC_SHA_256');
        return { Mac: new Uint8Array(createHmac('sha256', key).update(input.Message!).digest()) };
      },
    };
    const viaKms = await hmacLookup(new KmsMacSigner(kms as never, 'k'), 'p', 'v');
    expect(viaKms).toBe(await hmacLookup(new LocalMacSigner(key), 'p', 'v'));
  });
});

describe('Argon2Hasher', () => {
  it('uses argon2id with OWASP defaults and verifies', async () => {
    const h = new Argon2Hasher();
    const enc = await h.hash('123456');
    expect(enc.startsWith('$argon2id$')).toBe(true);
    expect(enc).toContain(`m=${ARGON2_DEFAULTS.memorySize},t=${ARGON2_DEFAULTS.iterations},p=1`);
    expect(enc).not.toContain('123456');
    expect(await h.verify(enc, '123456')).toBe(true);
    expect(await h.verify(enc, '123457')).toBe(false);
  });
  it('salts every hash; bad hash string verifies false', async () => {
    const h = new Argon2Hasher(FAST_ARGON2);
    expect(await h.hash('000000')).not.toBe(await h.hash('000000'));
    expect(await h.verify('not-a-hash', '000000')).toBe(false);
  });
});

describe('LocalEncryptor', () => {
  it('round-trips and binds context', async () => {
    const e = new LocalEncryptor();
    const ct = await e.encrypt('9876543210', { userId: 'u1' });
    expect(ct.startsWith('l1.')).toBe(true);
    expect(ct).not.toContain('9876543210');
    expect(await e.decrypt(ct, { userId: 'u1' })).toBe('9876543210');
    await expect(e.decrypt(ct, { userId: 'u2' })).rejects.toThrow();
    await expect(new LocalEncryptor().decrypt(ct, { userId: 'u1' })).rejects.toThrow();
    await expect(e.decrypt('garbage', {})).rejects.toThrow();
  });
  it('fresh IV per encryption', async () => {
    const e = new LocalEncryptor();
    expect(await e.encrypt('x', {})).not.toBe(await e.encrypt('x', {}));
  });
  it('rejects wrong key size', () => {
    expect(() => new LocalEncryptor(new Uint8Array(16))).toThrow();
  });
});

describe('KmsEnvelopeEncryptor', () => {
  it('wraps a data key per record and passes the encryption context', async () => {
    const wrapped = new Map<string, Uint8Array>();
    let n = 0;
    const kms = {
      send: async (cmd: unknown) => {
        if (cmd instanceof GenerateDataKeyCommand) {
          expect(cmd.input.KeySpec).toBe('AES_256');
          expect(cmd.input.EncryptionContext).toEqual({ userId: 'u1' });
          const pt = randomBytes(32);
          const blob = new TextEncoder().encode(`wrapped-${n++}`);
          wrapped.set(toBase64Url(blob), new Uint8Array(pt));
          return { Plaintext: new Uint8Array(pt), CiphertextBlob: blob };
        }
        if (cmd instanceof DecryptCommand) {
          expect(cmd.input.EncryptionContext).toEqual({ userId: 'u1' });
          return { Plaintext: new Uint8Array(wrapped.get(toBase64Url(cmd.input.CiphertextBlob!))!) };
        }
        throw new Error('unexpected command');
      },
    };
    const e = new KmsEnvelopeEncryptor(kms as never, 'key');
    const a = await e.encrypt('ABCPE1234F', { userId: 'u1' });
    const b = await e.encrypt('ABCPE1234F', { userId: 'u1' });
    expect(a.startsWith('k1.')).toBe(true);
    expect(a.split('.')[1]).not.toBe(b.split('.')[1]);
    expect(await e.decrypt(a, { userId: 'u1' })).toBe('ABCPE1234F');
  });
});
