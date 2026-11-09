import { describe, expect, it } from 'vitest';
import { OTP_RULES } from '@wealthfire/core';
import { AuthError } from '../../src/lib/errors';
import { contactLookup, normalizeContact, OTP_LIMITS } from '../../src/auth/otp';
import { EMAIL, MOBILE, setup } from './helpers';

const IP = '203.0.113.7';

async function errOf(p: Promise<unknown>): Promise<AuthError> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(AuthError);
  return e as AuthError;
}

describe('OTP limits mirror the app', () => {
  it('matches OTP_RULES', () => {
    expect(OTP_LIMITS).toMatchObject({
      length: OTP_RULES.length, expiryMs: OTP_RULES.expiryMs, maxTries: OTP_RULES.maxTries,
      resendCooldownMs: OTP_RULES.resendCooldownMs, maxSendsPerTarget: OTP_RULES.maxSendsPerWindow, targetWindowMs: OTP_RULES.windowMs,
    });
    expect(OTP_LIMITS.maxSendsPerIp).toBe(20);
    expect(OTP_LIMITS.ipWindowMs).toBe(3_600_000);
  });
});

describe('normalizeContact', () => {
  it('normalises and validates', () => {
    expect(normalizeContact('email', EMAIL)).toEqual({ kind: 'email', value: 'asha.rao@example.com' });
    expect(normalizeContact('mobile', MOBILE)).toEqual({ kind: 'mobile', value: '9876543210' });
    for (const [k, v] of [['email', 'nope'], ['mobile', '12345'], ['fax', '9876543210'], ['email', 5], ['email', 'a'.repeat(400)]]) {
      expect(() => normalizeContact(k, v)).toThrow(AuthError);
    }
  });
});

describe('OtpService.send', () => {
  it('sends a 6-digit code; stores only hash and ciphertext', async () => {
    const { otp, sender, repos, clock } = setup();
    const r = await otp.send({ kind: 'mobile', contact: MOBILE, ip: IP });
    expect(sender.lastCode).toMatch(/^\d{6}$/);
    expect(sender.last?.to).toBe('9876543210');
    expect(r.expiresAt).toBe(clock.now() + 5 * 60_000);
    expect(r.resendAt).toBe(clock.now() + 30_000);
    const c = (await repos.otp.getChallenge(r.challengeId))!;
    const stored = JSON.stringify(c);
    expect(stored).not.toContain(sender.lastCode!);
    expect(stored).not.toContain('9876543210');
    expect(c.codeHash.startsWith('$argon2id$')).toBe(true);
  });
  it('codes look uniform-ish (not constant)', async () => {
    const { otp, sender, clock } = setup();
    const codes = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await otp.send({ kind: 'email', contact: `u${i}@example.com`, ip: IP });
      codes.add(sender.lastCode!);
      clock.advance(1);
    }
    expect(codes.size).toBeGreaterThan(1);
  });
  it('30 s cooldown per target', async () => {
    const { otp, clock } = setup();
    await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    clock.advance(29_000);
    const e = await errOf(otp.send({ kind: 'email', contact: EMAIL.toLowerCase(), ip: IP }));
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(1000);
    clock.advance(1000);
    await expect(otp.send({ kind: 'email', contact: EMAIL, ip: IP })).resolves.toBeTruthy();
  });
  it('4 sends per target per 10 minutes', async () => {
    const { otp, clock } = setup();
    for (let i = 0; i < 4; i++) {
      await otp.send({ kind: 'mobile', contact: MOBILE, ip: IP });
      clock.advance(30_000);
    }
    const e = await errOf(otp.send({ kind: 'mobile', contact: MOBILE, ip: IP }));
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(10 * 60_000 - 4 * 30_000);
    // a different target is not affected
    await expect(otp.send({ kind: 'mobile', contact: '9123456789', ip: IP })).resolves.toBeTruthy();
    clock.advance(e.retryAfterMs!);
    await expect(otp.send({ kind: 'mobile', contact: MOBILE, ip: IP })).resolves.toBeTruthy();
  });
  it('20 sends per IP per hour', async () => {
    const { otp, clock } = setup();
    for (let i = 0; i < 20; i++) await otp.send({ kind: 'email', contact: `p${i}@example.com`, ip: IP });
    const e = await errOf(otp.send({ kind: 'email', contact: 'p20@example.com', ip: IP }));
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(3_600_000);
    await expect(otp.send({ kind: 'email', contact: 'p20@example.com', ip: '198.51.100.1' })).resolves.toBeTruthy();
    clock.advance(3_600_000);
    await expect(otp.send({ kind: 'email', contact: 'p21@example.com', ip: IP })).resolves.toBeTruthy();
  });
  it('a resend replaces the previous code', async () => {
    const { otp, sender, clock } = setup();
    const first = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    const oldCode = sender.lastCode!;
    clock.advance(30_000);
    await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    expect((await errOf(otp.verify({ challengeId: first.challengeId, code: oldCode }))).code).toBe('invalid_code');
  });
  it('sender failure is generic and removes the challenge', async () => {
    const { otp, sender, repos } = setup();
    sender.fail = true;
    const e = await errOf(otp.send({ kind: 'mobile', contact: MOBILE, ip: IP }));
    expect(e.code).toBe('send_failed');
    expect(`${e.message} ${e.stack}`).not.toMatch(/98765|\d{6}/);
    expect(repos.otp.challengeCount()).toBe(0);
  });
  it('send never reveals whether the contact has an account', async () => {
    const { otp, sender, clock } = setup();
    const a = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    await otp.verify({ challengeId: a.challengeId, code: sender.lastCode! });
    clock.advance(30_000);
    const existing = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    const fresh = await otp.send({ kind: 'email', contact: 'new@example.com', ip: IP });
    expect(Object.keys(existing).sort()).toEqual(Object.keys(fresh).sort());
  });
});

describe('OtpService.verify', () => {
  it('success creates the user once and returns tokens', async () => {
    const { otp, sender, repos, clock, mac, encryptor } = setup();
    const a = await otp.send({ kind: 'mobile', contact: MOBILE, ip: IP });
    const r1 = await otp.verify({ challengeId: a.challengeId, code: sender.lastCode!, device: 'android' });
    expect(r1.isNewUser).toBe(true);
    expect(r1.tokens.accessToken.split('.')).toHaveLength(3);
    expect(repos.users.size()).toBe(1);
    const u = (await repos.users.get(r1.tokens.userId))!;
    expect(u.contactHash).toBe(await contactLookup(mac, 'mobile', '9876543210'));
    expect(u.contactEnc).not.toContain('9876543210');
    expect(await encryptor.decrypt(u.contactEnc, { purpose: 'contact', userId: u.userId })).toBe('9876543210');

    clock.advance(30_000);
    const b = await otp.send({ kind: 'mobile', contact: '09876543210', ip: IP });
    const r2 = await otp.verify({ challengeId: b.challengeId, code: sender.lastCode! });
    expect(r2.isNewUser).toBe(false);
    expect(r2.tokens.userId).toBe(r1.tokens.userId);
    expect(repos.users.size()).toBe(1);
  });
  it('codes are single use', async () => {
    const { otp, sender } = setup();
    const a = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    const code = sender.lastCode!;
    await otp.verify({ challengeId: a.challengeId, code });
    expect((await errOf(otp.verify({ challengeId: a.challengeId, code }))).code).toBe('invalid_code');
  });
  it('expires after 5 minutes', async () => {
    const { otp, sender, clock, repos } = setup();
    const a = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    clock.advance(5 * 60_000);
    expect((await errOf(otp.verify({ challengeId: a.challengeId, code: sender.lastCode! }))).code).toBe('invalid_code');
    expect(repos.otp.challengeCount()).toBe(0);
  });
  it('works just before expiry', async () => {
    const { otp, sender, clock } = setup();
    const a = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    clock.advance(5 * 60_000 - 1);
    await expect(otp.verify({ challengeId: a.challengeId, code: sender.lastCode! })).resolves.toBeTruthy();
  });
  it('5 tries, then the challenge is gone even with the right code', async () => {
    const { otp, sender, repos } = setup();
    const a = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    const right = sender.lastCode!;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 5; i++) {
      const e = await errOf(otp.verify({ challengeId: a.challengeId, code: wrong }));
      expect(e.code).toBe('invalid_code');
      expect(e.triesLeft).toBe(5 - i);
    }
    expect(repos.otp.challengeCount()).toBe(0);
    expect((await errOf(otp.verify({ challengeId: a.challengeId, code: right }))).code).toBe('invalid_code');
    expect(repos.users.size()).toBe(0);
  });
  it('right code on the 5th try succeeds', async () => {
    const { otp, sender } = setup();
    const a = await otp.send({ kind: 'email', contact: EMAIL, ip: IP });
    const right = sender.lastCode!;
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await errOf(otp.verify({ challengeId: a.challengeId, code: wrong }));
    await expect(otp.verify({ challengeId: a.challengeId, code: right })).resolves.toMatchObject({ isNewUser: true });
  });
  it('bad input is bad_request; unknown challenge is invalid_code', async () => {
    const { otp } = setup();
    expect((await errOf(otp.verify({ challengeId: 'x', code: '123456' }))).code).toBe('bad_request');
    expect((await errOf(otp.verify({ challengeId: 'A'.repeat(22), code: '12345' }))).code).toBe('bad_request');
    expect((await errOf(otp.verify({ challengeId: 'A'.repeat(22), code: '123456' }))).code).toBe('invalid_code');
  });
  it('error text never contains the code or contact', async () => {
    const { otp, sender } = setup();
    const a = await otp.send({ kind: 'mobile', contact: MOBILE, ip: IP });
    const right = sender.lastCode!;
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
    const e = await errOf(otp.verify({ challengeId: a.challengeId, code: wrong }));
    const text = `${e.message} ${e.stack} ${JSON.stringify(e)}`;
    for (const secret of [right, wrong, '9876543210', a.challengeId]) expect(text).not.toContain(secret);
  });
});
