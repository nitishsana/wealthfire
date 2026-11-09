import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_URL_PREFIXES } from '../../src/kyc/service';
import { env, fullKyc, PANS, startBody } from './helpers';

const REVIEWER = { authorization: 'Bearer staff-token-reviewer-0001' };

describe('one PAN, one account (pan-in-use)', () => {
  it('a second account with the same PAN goes to under-review pan-in-use, with no paid call', async () => {
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
    expect(e.partner.calls.lookupKyc).toBe(calls);
    expect(e.repos.costs.rows.filter((r) => r.userId === u2)).toEqual([]);
    // never says which account holds the PAN
    for (const text of [JSON.stringify(s.json), JSON.stringify(await e.call('GET', '/kyc/status', { token: t2 }))]) {
      expect(text).not.toContain(u1);
    }
    // the first account is untouched
    expect((await e.call('GET', '/kyc/status', { token: t1 })).json).toMatchObject({ status: 'verified', reason: 'kra-validated' });
    // stored + audited like any other start
    expect(await e.repos.cases.get(u2)).toMatchObject({ status: 'under-review', reason: 'pan-in-use', version: 1 });
    expect((await e.repos.audit.listForUser(u2)).map((r) => r.action)).toEqual(['kyc.start']);
  });

  it('user steps stay closed; staff see it in the queue and can approve or reject', async () => {
    const e = env();
    const t1 = await e.signIn();
    const t2 = await e.signIn();
    const u2 = await e.userIdOf(t2);
    await e.call('POST', '/kyc/start', { token: t1, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) });
    expect((await e.call('POST', '/kyc/aadhaar', { token: t2, body: { mode: 'otp', returnUrl: 'wealthfire://kyc' } })).json.error)
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

describe('return-URL allow-list', () => {
  it('defaults to the app path, the local preview and the app scheme', () => {
    expect(DEFAULT_RETURN_URL_PREFIXES).toEqual(['https://nitishsana.github.io/wealthfire/', 'http://127.0.0.1:5180/', 'wealthfire://']);
  });

  it('accepts each allowed prefix', async () => {
    for (const returnUrl of ['https://nitishsana.github.io/wealthfire/kyc/return', 'http://127.0.0.1:5180/kyc', 'wealthfire://kyc/return']) {
      const e = env();
      const token = await e.signIn();
      await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
      const r = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl } });
      expect(r.statusCode, returnUrl).toBe(200);
    }
  });
});
