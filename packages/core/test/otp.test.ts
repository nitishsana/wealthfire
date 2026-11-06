import { describe, expect, it } from 'vitest';
import { DemoOtpProvider, OTP_RULES, createOtpProvider, verhoeffValid, type OtpSendResult } from '../src';

const T0 = Date.UTC(2026, 10, 6, 6, 0, 0);
const AADHAAR = '234123412346';

/** A Verhoeff-valid Aadhaar ending in 0000, for the no-linked-mobile demo path. */
function aadhaarEnding0000(): string {
  for (let p = 23412341; p < 99999999; p++) {
    const n = `${p}0000`;
    if (verhoeffValid(n)) return n;
  }
  throw new Error('none found');
}

/** First Verhoeff-valid 12-digit number at or after prefix*10000 that matches `re`. */
function aadhaarEnding(re: RegExp, prefix: number): string {
  for (let n = prefix * 10_000; ; n++) {
    const s = String(n);
    if (verhoeffValid(s) && re.test(s)) return s;
  }
}

function sent(r: OtpSendResult) {
  if (!r.ok) throw new Error(r.message);
  return r;
}

describe('DemoOtpProvider', () => {
  it('is labelled demo and sends a 6-digit code that expires in 5 minutes', async () => {
    const p = new DemoOtpProvider();
    expect(p.id).toBe('demo');
    expect(p.isDemo).toBe(true);
    const r = sent(await p.send({ channel: 'sms', target: '9876543210' }, T0));
    expect(r.demoCode).toMatch(/^\d{6}$/);
    expect(r.expiresAt).toBe(T0 + 5 * 60_000);
    expect(await p.verify(r.requestId, r.demoCode!, T0 + OTP_RULES.expiryMs)).toEqual({ ok: true });
  });

  it('zero-pads small codes', async () => {
    const p = new DemoOtpProvider(() => 0.000042);
    expect(sent(await p.send({ channel: 'email', target: 'a@b.com' }, T0)).demoCode).toBe('000042');
    const hi = new DemoOtpProvider(() => 0.9999999999);
    expect(sent(await hi.send({ channel: 'email', target: 'a@b.com' }, T0)).demoCode).toBe('999999');
  });

  it('expires at 5 minutes + 1 ms', async () => {
    const p = new DemoOtpProvider();
    const r = sent(await p.send({ channel: 'email', target: 'nitish@gmail.com' }, T0));
    const v = await p.verify(r.requestId, r.demoCode!, T0 + OTP_RULES.expiryMs + 1);
    expect(v).toEqual({ ok: false, reason: 'expired', message: 'Code expired. Send a new one.' });
  });

  it('5 wrong tries void the code', async () => {
    const p = new DemoOtpProvider(() => 0.5); // code 500000
    const r = sent(await p.send({ channel: 'sms', target: '9876543210' }, T0));
    for (let left = 4; left >= 1; left--) {
      const v = await p.verify(r.requestId, '111111', T0);
      expect(v).toMatchObject({ ok: false, reason: 'wrong' });
      if (!v.ok) expect(v.message).toBe(`Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
    expect(await p.verify(r.requestId, '111111', T0)).toMatchObject({ ok: false, reason: 'void' });
    expect(await p.verify(r.requestId, '500000', T0)).toMatchObject({ ok: false, reason: 'void' });
  });

  it('a new send voids the old code for the same channel + target only', async () => {
    const p = new DemoOtpProvider();
    const a = sent(await p.send({ channel: 'sms', target: '9876543210' }, T0));
    const other = sent(await p.send({ channel: 'email', target: 'nitish@gmail.com' }, T0));
    const b = sent(await p.send({ channel: 'sms', target: '+91 98765 43210' }, T0 + 30_000));
    expect(b.requestId).not.toBe(a.requestId);
    expect(await p.verify(a.requestId, a.demoCode!, T0 + 31_000)).toMatchObject({ ok: false, reason: 'void' });
    expect(await p.verify(b.requestId, b.demoCode!, T0 + 31_000)).toEqual({ ok: true });
    expect(await p.verify(other.requestId, other.demoCode!, T0 + 31_000)).toEqual({ ok: true });
  });

  it('a used code cannot be used again; unknown id is void', async () => {
    const p = new DemoOtpProvider();
    const r = sent(await p.send({ channel: 'sms', target: '9876543210' }, T0));
    expect((await p.verify(r.requestId, r.demoCode!, T0)).ok).toBe(true);
    expect(await p.verify(r.requestId, r.demoCode!, T0)).toMatchObject({ ok: false, reason: 'void' });
    expect(await p.verify('nope', '123456', T0)).toMatchObject({ ok: false, reason: 'void' });
  });

  it('an expired code is removed from memory', async () => {
    const p = new DemoOtpProvider();
    const r = sent(await p.send({ channel: 'aadhaar', target: AADHAAR }, T0));
    expect(p.pendingCount()).toBe(1);
    expect(await p.verify(r.requestId, r.demoCode!, T0 + OTP_RULES.expiryMs + 1)).toMatchObject({ reason: 'expired' });
    expect(p.pendingCount()).toBe(0);
    expect(await p.verify(r.requestId, r.demoCode!, T0)).toMatchObject({ ok: false, reason: 'void' });
  });

  it('sending for a new Aadhaar drops every older Aadhaar code', async () => {
    const p = new DemoOtpProvider();
    const y = aadhaarEnding(/^(?!.*0000$)/, 98765432);
    const sms = sent(await p.send({ channel: 'sms', target: '9876543210' }, T0));
    const x = sent(await p.send({ channel: 'aadhaar', target: AADHAAR }, T0));
    const yr = sent(await p.send({ channel: 'aadhaar', target: y }, T0 + 1_000));
    expect(p.pendingCount()).toBe(2); // sms + Y only; X's full number is gone
    expect(await p.verify(x.requestId, x.demoCode!, T0 + 2_000)).toMatchObject({ ok: false, reason: 'void' });
    expect(await p.verify(yr.requestId, yr.demoCode!, T0 + 2_000)).toEqual({ ok: true, aadhaarLast4: y.slice(-4) });
    expect(await p.verify(sms.requestId, sms.demoCode!, T0 + 2_000)).toEqual({ ok: true });
    expect(p.pendingCount()).toBe(0);
  });

  it('Aadhaar channel returns aadhaarLast4', async () => {
    const p = new DemoOtpProvider();
    const r = sent(await p.send({ channel: 'aadhaar', target: AADHAAR }, T0));
    expect(await p.verify(r.requestId, r.demoCode!, T0)).toEqual({ ok: true, aadhaarLast4: '2346' });
  });

  it('Aadhaar ending 0000 → no-linked-mobile', async () => {
    const p = new DemoOtpProvider();
    const n = aadhaarEnding0000();
    const r = await p.send({ channel: 'aadhaar', target: n }, T0);
    expect(r).toEqual({
      ok: false,
      reason: 'no-linked-mobile',
      message: 'Your Aadhaar has no linked mobile. Link one at an Aadhaar centre, then try again.',
    });
  });

  it('invalid targets are refused', async () => {
    const p = new DemoOtpProvider();
    expect(await p.send({ channel: 'sms', target: '123' }, T0)).toMatchObject({ ok: false, reason: 'invalid-target' });
    expect(await p.send({ channel: 'email', target: 'x' }, T0)).toMatchObject({ ok: false, reason: 'invalid-target' });
    expect(await p.send({ channel: 'aadhaar', target: '234123412347' }, T0)).toMatchObject({ ok: false, reason: 'invalid-target' });
  });
});

describe('createOtpProvider', () => {
  it('undefined or demo → demo provider', () => {
    expect(createOtpProvider({})).toBeInstanceOf(DemoOtpProvider);
    expect(createOtpProvider({ provider: 'demo' }).isDemo).toBe(true);
    expect(createOtpProvider({ provider: '' })).toBeInstanceOf(DemoOtpProvider);
  });
  it('real providers are not built yet', () => {
    expect(() => createOtpProvider({ provider: 'digio' })).toThrow('OTP provider "digio" is not built yet');
    expect(() => createOtpProvider({ provider: 'digilocker', apiUrl: 'https://x' })).toThrow('not built yet');
  });
});
