import { describe, expect, it } from 'vitest';
import { hmacLookup } from '../../src/lib/crypto';
import { scrub } from '../../src/kyc/log';
import { MOBILE } from '../auth/helpers';
import { env, FULL_AADHAAR, fullKyc, PANS, RETURN_URL, startBody } from './helpers';

const ALL_PANS = Object.values(PANS);
const variants = (pan: string) => [pan, pan.toLowerCase(), pan.slice(0, 5) + pan.slice(5, 9)];

describe('sensitive data (R6, design §7)', () => {
  it('full Aadhaar is never stored, even when a client sends it', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass, { aadhaar: FULL_AADHAAR, aadhaarNumber: FULL_AADHAAR }) });
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'otp', returnUrl: RETURN_URL, aadhaar: FULL_AADHAAR } });
    await e.svc.recordAadhaar(userId, { verified: true, last4: '1234', full: FULL_AADHAAR } as never);
    const stored = JSON.stringify([
      e.repos.cases.all(), e.repos.audit.rows, [...e.repos.idempotency.items.values()], e.repos.costs.rows,
    ]);
    expect(stored).not.toContain(FULL_AADHAAR);
    expect(stored).not.toContain('23456789');
    expect(e.repos.cases.all()[0]!.masks.aadhaar).toBe('XXXX XXXX 1234');
  });

  it('PAN is stored only encrypted + HMAC lookup key; masks keep the last 4', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    const rec = (await e.repos.cases.get(userId))!;
    expect(rec.panEnc).toMatch(/^l1\./);
    expect(await e.encryptor.decrypt(rec.panEnc, { purpose: 'pan', userId })).toBe(PANS.fullPass);
    await expect(e.encryptor.decrypt(rec.panEnc, { purpose: 'pan', userId: 'someone-else' })).rejects.toThrow();
    expect(rec.panHash).toBe(await hmacLookup(e.mac, 'pan', PANS.fullPass));
    expect(rec.masks.pan).toBe('XXXXXX002K');
    const stored = JSON.stringify([e.repos.cases.all(), e.repos.audit.rows, [...e.repos.idempotency.items.values()], e.repos.costs.rows]);
    for (const v of variants(PANS.fullPass)) expect(stored).not.toContain(v);
  });

  it('no response (success, error or replay) contains a PAN, full Aadhaar, contact or OTP', async () => {
    const e = env();
    const token = await e.signIn();
    const code = e.sender.lastCode!;
    for (const pan of [PANS.kraValidated, PANS.unclear, PANS.reject, PANS.timeout]) {
      const t = await e.signIn();
      if (pan === PANS.kraValidated || pan === PANS.timeout) await e.call('POST', '/kyc/start', { token: t, body: startBody(pan) });
      else await fullKyc(e, t, pan);
    }
    await fullKyc(e, token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass), idem: 'replay-key-01' });
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass), idem: 'replay-key-01' });
    await e.call('POST', '/kyc/start', { token, body: startBody('ABCPR123') }); // 400
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass, { aadhaarLast4: FULL_AADHAAR }) }); // 400
    await e.call('POST', '/kyc/start', { token: 'not-a-token', body: startBody(PANS.fullPass) }); // 401
    // KYC responses only (auth verify responses legitimately carry the caller's own tokens)
    const kycBodies = e.seen.filter((b) => !b.includes('accessToken'));
    const blob = kycBodies.join('\n');
    for (const p of ALL_PANS) for (const v of variants(p)) expect(blob).not.toContain(v);
    expect(blob).not.toContain(FULL_AADHAAR);
    expect(blob).not.toContain('98765');
    expect(blob).not.toContain(code);
    expect(blob).not.toContain(token);
  });

  it('logs hold only route, status and latency; nothing sensitive', async () => {
    const e = env();
    const token = await e.signIn();
    await fullKyc(e, token);
    await e.call('POST', '/kyc/start', { token: 'garbage', body: startBody(PANS.fullPass) });
    expect(e.logger.lines.length).toBeGreaterThan(5);
    const blob = e.logger.lines.join('\n');
    for (const v of variants(PANS.fullPass)) expect(blob).not.toContain(v);
    expect(blob).not.toContain(token);
    expect(blob).not.toContain('98765');
    for (const line of e.logger.lines) {
      expect(Object.keys(JSON.parse(line)).sort()).toEqual(['event', 'level', 'ms', 'route', 'status']);
    }
  });

  it('scrub masks PAN, Aadhaar, mobile, email, JWT and long tokens', () => {
    const s = scrub(`pan ABCPE1234F aadhaar 2345 6789 1234 m ${MOBILE} e a.b@example.com jwt eyJhbGciOi.eyJzdWIiOi.c2ln t ${'A'.repeat(43)}`);
    expect(s).not.toMatch(/ABCPE1234F|2345 6789 1234|98765|a\.b@example\.com|eyJhbGciOi|AAAAAAAAAAAAAAAAAAAAAAAA/);
    expect(scrub('route POST /kyc/start status 200')).toBe('route POST /kyc/start status 200');
  });
});
