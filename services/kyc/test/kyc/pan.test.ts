import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_URL_PREFIXES } from '../../src/lib/returnUrl';
import { env, fullKyc, grantAllConsents, PANS, startBody } from './helpers';

const REVIEWER = { authorization: 'Bearer staff-token-reviewer-0001' };

describe('one PAN, one account (pan-in-use)', () => {
  it('a second account with the same PAN goes to under-review pan-in-use; the KRA lookup + PAN check still run for staff (R1)', async () => {
    const e = env();
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    const u1 = await e.userIdOf(t1);
    const u2 = await e.userIdOf(t2);
    expect((await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.kraValidated) })).json.status).toBe('verified');
    const calls = e.partner.calls.lookupKyc;

    const s = await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.kraValidated) });
    expect(s.statusCode).toBe(200);
    expect(s.json).toMatchObject({ status: 'under-review', reason: 'pan-in-use', next: 'wait', eligibleToInvest: false });
    expect(e.partner.calls.lookupKyc).toBe(calls + 1);
    expect(e.partner.calls.verifyPan).toBe(1);
    expect(e.repos.costs.rows.filter((r) => r.userId === u2).map((r) => r.check)).toEqual(['kra-lookup', 'pan-verify']);
    expect(s.json.checks).toMatchObject({ kra: 'pass', 'kra-name': 'pass', 'kra-dob': 'pass', pan: 'pass' });
    // never says which account holds the PAN
    for (const text of [JSON.stringify(s.json), JSON.stringify(await e.call('GET', '/kyc/status', { token: t2 }))]) {
      expect(text).not.toContain(u1);
    }
    // the first account is untouched
    expect((await e.call('GET', '/kyc/status', { token: t1 })).json).toMatchObject({ status: 'verified', reason: 'kra-validated' });
    // stored + audited like any other start
    expect(await e.repos.cases.get(u2)).toMatchObject({ status: 'under-review', reason: 'pan-in-use', next: 'wait', version: 3 });
    expect(e.repos.audit.all().filter((r) => r.userId === u2).map((r) => r.action)).toEqual(['kyc.start', 'kyc.kra-retry', 'kyc.pan-retry']);
    // the PAN stays claimed by the first account
    expect(e.repos.cases.panOwner((await e.repos.cases.get(u1))!.panHash)).toBe(u1);
  });

  it('user steps stay closed; staff see it in the queue and can approve or reject', async () => {
    const e = env();
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    const u2 = await e.userIdOf(t2);
    await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) });
    expect((await e.call('POST', '/kyc/aadhaar', { token: t2, body: { mode: 'otp', returnUrl: 'wealthfire://kyc-return' } })).json.error)
      .toBe('wrong_step');
    expect((await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) })).json.error).toBe('already_started');
    const list = await e.call('GET', '/review/cases', { headers: REVIEWER });
    expect(list.json.items).toEqual([expect.objectContaining({ id: u2, reason: 'pan-in-use' })]);
    const r = await e.call('POST', `/review/cases/${u2}`, { headers: REVIEWER, body: { action: 'reject', reason: 'Duplicate account' } });
    expect(r.statusCode).toBe(200);
    expect((await e.call('GET', '/kyc/status', { token: t2 })).json).toMatchObject({ status: 'rejected', reason: 'staff-rejected' });
  });

  it('the same account starting again keeps its own PAN; a rejected non-individual PAN claims nothing', async () => {
    const e = env();
    const t1 = await e.signIn();
    const u1 = await e.userIdOf(t1);
    expect(await e.repos.cases.claimPan('some-hash', u1)).toBe(true);
    expect(await e.repos.cases.claimPan('some-hash', u1)).toBe(true);
    expect(await e.repos.cases.claimPan('some-hash', 'someone-else')).toBe(false);

    const t2 = await e.signIn();
    const t3 = await e.signIn();
    expect((await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.company) })).json.reason).toBe('pan-not-individual');
    // the company PAN was never claimed, so it does not block another account (it is rejected there too)
    expect((await e.call('POST', '/kyc/start', { token: t3, body: startBody(PANS.company) })).json.reason).toBe('pan-not-individual');
  });

  it('a hand-check case with a PAN in use is marked pan-in-use for the reviewer', async () => {
    const e = env();
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    await fullKyc(e, t1);
    const s = await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass, { deviceResult: 'under-review' }) });
    expect(s.json).toMatchObject({ status: 'under-review', reason: 'pan-in-use' });
  });
});

describe('R9: a failed start releases its PAN claim', () => {
  it('start refused for a missing consent after claiming: the PAN is free for another account', async () => {
    const e = env({}, { consents: false });
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    const u2 = await e.userIdOf(t2);
    const s1 = await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) });
    expect(s1.statusCode).toBe(409);
    expect(s1.json.error).toBe('consent-required');
    expect(await e.repos.cases.get(await e.userIdOf(t1))).toBeNull();
    await grantAllConsents(e.repos, u2);
    const s2 = await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) });
    expect(s2.json).toMatchObject({ status: 'pre-verified', next: 'aadhaar' });
    expect(s2.json.reason).not.toBe('pan-in-use');
  });

  it('start refused at the daily cap or with the partner down: the claim is released too', async () => {
    const e = env({ maxPaidChecksPerDay: 1 });
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    const u1 = await e.userIdOf(t1);
    // use up t1's only paid check, then archive nothing: start fails with limit_reached
    expect(await e.repos.costs.reserve(u1, new Date(e.clock.now() + 330 * 60_000).toISOString().slice(0, 10), 1)).toBe(true);
    const s1 = await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) });
    expect(s1.statusCode).toBe(429);
    const realLookup = e.partner.lookupKyc.bind(e.partner);
    e.partner.lookupKyc = async () => { throw new Error('boom'); };
    const s2 = await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) });
    expect(s2.statusCode).toBe(503);
    e.partner.lookupKyc = realLookup;
    const t3 = await e.signIn();
    const s3 = await e.call('POST', '/kyc/start', { token: t3, body: startBody(PANS.fullPass) });
    expect(s3.json).toMatchObject({ status: 'pre-verified', next: 'aadhaar' });
  });

  it('a parallel start that saved first keeps the claim', async () => {
    const e = env();
    const t1 = await e.signIn();
    const u1 = await e.userIdOf(t1);
    await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) });
    const hash = (await e.repos.cases.get(u1))!.panHash;
    // a second start for the same user goes the "existing case" way and never releases
    expect((await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) })).json.error).toBe('already_started');
    expect(e.repos.cases.panOwner(hash)).toBe(u1);
  });
});

describe('return-URL allow-list', () => {
  it('defaults to the app path and the exact app deep link (no loopback)', () => {
    expect(DEFAULT_RETURN_URL_PREFIXES).toEqual(['https://nitishsana.github.io/wealthfire/', 'wealthfire://kyc-return']);
  });

  it('accepts each allowed prefix', async () => {
    for (const returnUrl of ['https://nitishsana.github.io/wealthfire/kyc/return', 'https://nitishsana.github.io/wealthfire/?kyc=return#/settings', 'wealthfire://kyc-return']) {
      const e = env();
      const token = await e.signIn();
      await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
      const r = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl } });
      expect(r.statusCode, returnUrl).toBe(200);
    }
  });
});
