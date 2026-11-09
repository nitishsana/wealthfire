import { describe, expect, it } from 'vitest';
import { DEFAULT_CHECK_COSTS } from '../../src/kyc/service';
import { MOBILE } from '../auth/helpers';
import { env, fullKyc, PANS, RETURN_URL, startBody } from './helpers';

describe('Idempotency-Key on paid POSTs', () => {
  it('is required on every paid route; nothing is called without it', async () => {
    const e = env();
    const token = await e.signIn();
    for (const [path, body] of [
      ['/kyc/start', startBody(PANS.fullPass)],
      ['/kyc/aadhaar', { mode: 'otp', returnUrl: RETURN_URL }],
      ['/kyc/selfie', { uploadId: 'selfie-11111111-1111-4111-8111-111111111111.jpg' }],
      ['/kyc/esign', { returnUrl: RETURN_URL }],
    ] as const) {
      const r = await e.call('POST', path, { token, body, idem: null });
      expect(r.statusCode).toBe(400);
      expect(r.json.error).toBe('missing_idempotency_key');
    }
    expect(Object.values(e.partner.calls).every((n) => n === 0)).toBe(true);
    expect(e.repos.costs.rows).toEqual([]);
  });

  it('a malformed key is refused', async () => {
    const e = env();
    const token = await e.signIn();
    for (const idem of ['short', 'x'.repeat(129), 'has space here', 'emoji-\u{1F600}-key']) {
      const r = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass), idem });
      expect(r.statusCode).toBe(400);
    }
  });

  it('same key + same body replays the stored result without a second paid call', async () => {
    const e = env();
    const token = await e.signIn();
    const a = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass), idem: 'start-key-0001' });
    const b = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass), idem: 'start-key-0001' });
    expect(b.statusCode).toBe(200);
    expect(b.json).toEqual(a.json);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(e.partner.calls.lookupKyc).toBe(1);
    expect(e.repos.costs.rows.length).toBe(1);
  });

  it('same key + different body → 422; a new key on a started case → 409', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass), idem: 'start-key-0002' });
    const other = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated), idem: 'start-key-0002' });
    expect(other.statusCode).toBe(422);
    expect(other.json.error).toBe('idempotency_mismatch');
    const fresh = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated), idem: 'start-key-0003' });
    expect(fresh.json.error).toBe('already_started');
    expect(e.partner.calls.lookupKyc).toBe(1);
  });

  it('keys are per user and per route', async () => {
    const e = env();
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    const a = await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass), idem: 'shared-key-01' });
    const b = await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.kraValidated), idem: 'shared-key-01' });
    expect(a.json.status).toBe('pre-verified');
    expect(b.json.status).toBe('verified');
    const c = await e.call('POST', '/kyc/aadhaar', { token: t1, body: { mode: 'otp', returnUrl: RETURN_URL }, idem: 'shared-key-01' });
    expect(c.statusCode).toBe(200);
  });

  it('a request that failed (no stored result) frees its key', async () => {
    const e = env();
    const token = await e.signIn();
    const early = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'otp', returnUrl: RETURN_URL }, idem: 'aadhaar-key-01' });
    expect(early.statusCode).toBe(404);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const ok = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'otp', returnUrl: RETURN_URL }, idem: 'aadhaar-key-01' });
    expect(ok.statusCode).toBe(200);
  });

  it('a request still running is 409 in_progress', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = e.svc.idempotent(userId, 'start', 'slow-key-0001', {}, async () => {
      await gate;
      return { status: 200, body: {} };
    });
    await expect(e.svc.idempotent(userId, 'start', 'slow-key-0001', {}, async () => ({ status: 200, body: {} })))
      .rejects.toMatchObject({ code: 'in_progress' });
    release();
    await slow;
  });
});

describe('daily paid-check cap (R7) and costs', () => {
  it('blocks user-triggered paid calls past the cap; resets the next IST day', async () => {
    const e = env({ maxPaidChecksPerDay: 2 });
    const token = await e.signIn();
    await fullKyc(e, token); // kra-lookup (1) + aadhaar (2); pan check is a system follow-up
    const id = await e.uploadSelfie(token);
    const blocked = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json.error).toBe('limit_reached');
    expect(e.partner.calls.faceMatch).toBe(0);
    expect(e.partner.calls.verifyPan).toBe(1); // not blocked
    e.clock.advance(24 * 60 * 60_000);
    const again = await e.signIn(MOBILE); // the access token expired meanwhile; same user
    expect(await e.userIdOf(again)).toBe(e.repos.cases.all()[0]!.userId);
    const ok = await e.call('POST', '/kyc/selfie', { token: again, body: { uploadId: id } });
    expect(ok.statusCode).toBe(200);
  });

  it('the cap is per user', async () => {
    const e = env({ maxPaidChecksPerDay: 1 });
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    expect((await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) })).statusCode).toBe(200);
    expect((await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) })).statusCode).toBe(200);
    expect((await e.call('POST', '/kyc/aadhaar', { token: t1, body: { mode: 'otp', returnUrl: RETURN_URL } })).statusCode).toBe(429);
  });

  it('a capped start creates no case', async () => {
    const e = env({ maxPaidChecksPerDay: 1 });
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.repos.costs.reserve(userId, '2026-11-06', 1);
    const r = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(r.statusCode).toBe(429);
    expect(await e.repos.cases.get(userId)).toBeNull();
  });

  it('logs one cost row per partner attempt with check, ₹ cost, user and month', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    expect(e.repos.costs.rows).toEqual([
      { month: '2026-11', checkId: expect.any(String), check: 'kra-lookup', costInr: DEFAULT_CHECK_COSTS['kra-lookup'], userId, at: new Date(e.clock.now()).toISOString() },
    ]);
    expect(await e.repos.costs.used(userId, '2026-11-06')).toBe(1);
  });
});
