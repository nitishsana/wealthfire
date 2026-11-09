// Wave 4 server rows owned by the KYC routes: R3 retry, R7 18+, S2 consent / withdraw / delete,
// S11 upload signing cap + linking, S14 magic bytes, S18 idempotency TTL.
import { describe, expect, it } from 'vitest';
import { kycRoutes } from '../../src/kyc/routes';
import { AUTO_RETRY_MS, istToday, MAX_SIGNINGS_PER_DAY, newConsentStartsNewCase } from '../../src/kyc/service';
import { sniffType } from '../../src/kyc/uploads';
import { env, fullKyc, grantAllConsents, PANS, RETURN_URL, startBody } from './helpers';

const REVIEWER = { authorization: 'Bearer staff-token-reviewer-0001' };

describe('route map exports the wave-4 routes (the router registers whatever the map holds)', () => {
  it('has retry, consent, withdraw and delete-data', () => {
    const keys = Object.keys(kycRoutes(env().svc));
    expect(keys).toEqual(expect.arrayContaining(['POST /kyc/retry', 'POST /kyc/consent', 'POST /kyc/consent/withdraw', 'DELETE /kyc/data']));
  });
});

describe('R3: POST /kyc/retry and the status auto-retry', () => {
  it('a KRA timeout: POST /kyc/retry re-runs the lookup (paid, Idempotency-Key, counts toward the cap)', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect(e.repos.costs.rows).toHaveLength(2);
    e.partner.setScenario(PANS.timeout, 'kra-validated');
    expect((await e.call('POST', '/kyc/retry', { token, idem: null })).json.error).toBe('missing_idempotency_key');
    const r = await e.call('POST', '/kyc/retry', { token });
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ status: 'verified', path: 'kra-validated' });
    expect(r.json.redo).toBeUndefined();
    expect(e.repos.costs.rows).toHaveLength(3);
  });

  it('a user-step timeout (selfie / e-sign / Aadhaar): retry says which step to redo, no paid call', async () => {
    const e = env();
    const token = await e.signIn();
    await fullKyc(e, token);
    e.partner.failNext('faceMatch', 2);
    const id = await e.uploadSelfie(token);
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } });
    const paidBefore = e.repos.costs.rows.length;
    const r = await e.call('POST', '/kyc/retry', { token });
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout', redo: 'selfie' });
    expect(e.repos.costs.rows.length).toBe(paidBefore);
    // the redo step is open
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } })).json.next).toBe('esign');
  });

  it('e-sign timeout → redo esign; Aadhaar timeout → redo aadhaar', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    await e.svc.recordEsign(userId, 'timeout');
    expect((await e.call('POST', '/kyc/retry', { token })).json.redo).toBe('esign');

    const e2 = env();
    const t2 = await e2.signIn();
    const u2 = await e2.userIdOf(t2);
    await e2.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) });
    await e2.call('POST', '/kyc/aadhaar', { token: t2, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    await e2.svc.recordAadhaar(u2, 'timeout');
    expect((await e2.call('POST', '/kyc/retry', { token: t2 })).json.redo).toBe('aadhaar');
  });

  it('accepts an empty body {} (or none) with an Idempotency-Key', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect((await e.call('POST', '/kyc/retry', { token, body: {} })).statusCode).toBe(200);
    expect((await e.call('POST', '/kyc/retry', { token })).statusCode).toBe(200);
    expect((await e.call('POST', '/kyc/retry', { token, body: '' })).statusCode).toBe(200);
  });

  it('nothing to retry → 409 wrong_step; a decided case → 409 decided; no case → 404', async () => {
    const e = env();
    const token = await e.signIn();
    expect((await e.call('POST', '/kyc/retry', { token })).statusCode).toBe(404);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect((await e.call('POST', '/kyc/retry', { token })).json.error).toBe('wrong_step');
    const t2 = await e.signIn();
    await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.kraValidated) });
    expect((await e.call('POST', '/kyc/retry', { token: t2 })).json.error).toBe('decided');
  });

  it('a retry past the daily cap is refused (429)', async () => {
    const e = env({ maxPaidChecksPerDay: 2 });
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) }); // 2 tries = the cap
    expect((await e.call('POST', '/kyc/retry', { token })).statusCode).toBe(429);
  });

  it('GET /kyc/status re-runs a timed-out system step at most once per 10 minutes', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect(e.partner.calls.lookupKyc).toBe(2);
    await e.call('GET', '/kyc/status', { token }); // first read: retried (2 tries, still timing out)
    expect(e.partner.calls.lookupKyc).toBe(4);
    await e.call('GET', '/kyc/status', { token });
    e.clock.advance(AUTO_RETRY_MS - 1);
    await e.call('GET', '/kyc/status', { token });
    expect(e.partner.calls.lookupKyc).toBe(4); // inside the 10 minutes: no paid call
    e.clock.advance(1);
    e.partner.setScenario(PANS.timeout, 'kra-validated');
    const st = await e.call('GET', '/kyc/status', { token });
    expect(e.partner.calls.lookupKyc).toBe(5);
    expect(st.json).toMatchObject({ status: 'verified', path: 'kra-validated' });
    // every auto-retry counted toward the cap and was logged
    expect(e.repos.costs.rows.filter((r) => r.check === 'kra-lookup')).toHaveLength(5);
    expect(e.repos.audit.all().filter((r) => r.action === 'kyc.auto-retry')).toHaveLength(2);
  });

  it('the status auto-retry never fails the read (cap reached: the step just waits)', async () => {
    const e = env({ maxPaidChecksPerDay: 2 });
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.statusCode).toBe(200);
    expect(st.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
    expect(e.partner.calls.lookupKyc).toBe(2);
  });
});

describe('R7: 18+ on the date of birth (packages/core validateDob)', () => {
  it('under 18 on India\u2019s date is refused; 18 today is allowed', async () => {
    const e = env(); // clock 2026-11-06 17:30 IST
    const token = await e.signIn();
    const minor = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass, { dob: '08/11/2008' }) });
    expect(minor.statusCode).toBe(400);
    expect(minor.json).toEqual({ error: 'under_age', message: 'You must be 18 or older to invest.' });
    expect(e.partner.calls.lookupKyc).toBe(0);
    expect(e.repos.costs.rows).toEqual([]);
    const ok = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass, { dob: '2008-11-06' }) });
    expect(ok.statusCode).toBe(200);
  });

  it('uses the IST calendar date, not UTC', () => {
    // 2026-11-06 20:00 UTC is already 7 Nov in India
    const d = istToday(Date.UTC(2026, 10, 6, 20, 0, 0));
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 11, 7]);
  });

  it('a future or 120+ year date of birth is a bad request', async () => {
    const e = env();
    const token = await e.signIn();
    for (const dob of ['01/01/2030', '01/01/1900']) {
      expect((await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass, { dob }) })).json.error).toBe('bad_request');
    }
  });
});

describe('S2: consent records', () => {
  it('every paid call needs a prior consent for its purpose, else 409 consent-required', async () => {
    const e = env({}, { consents: false });
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(s.statusCode).toBe(409);
    expect(s.json.error).toBe('consent-required');
    expect(e.partner.calls.lookupKyc).toBe(0);
    expect(e.repos.costs.rows).toEqual([]);

    const c = await e.call('POST', '/kyc/consent', { token, body: { purpose: 'pan-check' } });
    expect(c.statusCode).toBe(200);
    expect(c.json).toMatchObject({ purpose: 'pan-check', consent: 'given', kyc: { status: null, next: 'start' } });
    expect(e.repos.consents.rows).toEqual([expect.objectContaining({ userId, purpose: 'pan-check', action: 'given', ip: '203.0.113.7' })]);
    expect(e.repos.consents.rows[0]!.sk).toMatch(/^pan-check#2026-11-06T/);
    expect((await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) })).statusCode).toBe(200);

    // Aadhaar: the consent follows the mode
    const a = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    expect(a.json.error).toBe('consent-required');
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'aadhaar-otp' } });
    expect((await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } })).json.error).toBe('consent-required');
    expect((await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'otp', returnUrl: RETURN_URL } })).statusCode).toBe(200);
    await e.svc.recordAadhaar(userId, { verified: true, last4: '1234' });

    // selfie needs face-match
    const id = await e.uploadSelfie(token);
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } })).json.error).toBe('consent-required');
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'face-match' } });
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } })).json.next).toBe('esign');

    // e-sign needs esign; the KRA upload needs kra-upload (a system step: it waits, no error)
    expect((await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } })).json.error).toBe('consent-required');
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'esign' } });
    expect((await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } })).statusCode).toBe(200);
    const done = await e.svc.recordEsign(userId, 'done');
    expect(done).toMatchObject({ status: 'verified', next: 'kra-upload' });
    expect(e.partner.calls.uploadToKra).toBe(0);
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'kra-upload' } });
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: 'verified', next: 'none' });
    expect(e.partner.calls.uploadToKra).toBe(1);
  });

  it('refuses an unknown purpose', async () => {
    const e = env();
    const token = await e.signIn();
    for (const body of [{}, { purpose: 'kra-lookup' }, { purpose: 42 }]) {
      expect((await e.call('POST', '/kyc/consent', { token, body })).statusCode).toBe(400);
      expect((await e.call('POST', '/kyc/consent/withdraw', { token, body })).statusCode).toBe(400);
    }
  });

  it('withdraw stops an open case (consent-withdrawn) and blocks paid calls for that purpose', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    const w = await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'face-match' } });
    expect(w.statusCode).toBe(200);
    expect(w.json).toMatchObject({ purpose: 'face-match', consent: 'withdrawn', kyc: { status: 'rejected', reason: 'consent-withdrawn', next: 'start' } });
    expect(await e.svc.hasConsent(userId, 'face-match')).toBe(false);
    expect(await e.svc.hasConsent(userId, 'esign')).toBe(true);
    const anySelfie = 'selfie-00000000-0000-0000-0000-000000000000.jpg';
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: anySelfie } })).json.error).toBe('wrong_step');
    expect(e.partner.calls.faceMatch).toBe(0);
    expect(e.repos.audit.all().filter((r) => r.action === 'kyc.consent-withdrawn')).toHaveLength(1);
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: 'rejected', reason: 'consent-withdrawn', eligibleToInvest: false });
  });

  it('withdraw on a verified case records the withdrawal but does not undo the KYC', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    const w = await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'pan-check' } });
    expect(w.json.kyc).toMatchObject({ status: 'verified' });
  });

  it('consent given again after a withdrawal starts a NEW case; the old one stays consent-withdrawn (archived)', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'esign' } });
    const old = (await e.repos.cases.get(userId))!;
    expect(newConsentStartsNewCase(old)).toBe(true);
    const c = await e.call('POST', '/kyc/consent', { token, body: { purpose: 'esign' } });
    expect(c.json.kyc).toMatchObject({ status: null, next: 'start' });
    expect(await e.repos.cases.get(userId)).toBeNull();
    const archived = [...e.repos.cases.archived.entries()];
    expect(archived).toHaveLength(1);
    expect(archived[0]![0]).toMatch(new RegExp(`^arch#${userId}#`));
    expect(archived[0]![1]).toMatchObject({ status: 'rejected', reason: 'consent-withdrawn' });
    expect(archived[0]![1]).not.toHaveProperty('panEnc');
    // the same PAN can be used again for the new case
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(s.json).toMatchObject({ status: 'pre-verified', next: 'aadhaar' });
    expect(e.repos.audit.all().filter((r) => r.action === 'kyc.case-archived')).toHaveLength(1);
    // a consent on a live case does not archive it
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'esign' } });
    expect(await e.repos.cases.get(userId)).not.toBeNull();
  });

  it('withdraw for a purpose with no row (or twice) answers 200', async () => {
    const e = env({}, { consents: false });
    const token = await e.signIn();
    for (let i = 0; i < 2; i++) {
      const w = await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'kra-upload' } });
      expect(w.statusCode).toBe(200);
      expect(w.json).toMatchObject({ purpose: 'kra-upload', consent: 'withdrawn', kyc: { status: null, next: 'start' } });
    }
  });

  it('after a withdrawal, status says next start and POST /kyc/start makes a NEW case (old one archived)', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'face-match' } });
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'rejected', reason: 'consent-withdrawn', next: 'start', eligibleToInvest: false });
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(s.statusCode).toBe(200);
    expect(s.json).toMatchObject({ status: 'pre-verified', next: 'aadhaar', reason: 'in-progress' });
    expect([...e.repos.cases.archived.values()]).toEqual([expect.objectContaining({ userId, reason: 'consent-withdrawn' })]);
    // the new case still needs the withdrawn consent at its step
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    await e.svc.recordAadhaar(userId, { verified: true, last4: '1234' });
    const id = await e.uploadSelfie(token);
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } })).json.error).toBe('consent-required');
  });

  it('a new start after withdrawing pan-check is refused (consent-required) and leaves the old case as it was', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'pan-check' } });
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(s.json.error).toBe('consent-required');
    expect((await e.repos.cases.get(userId))!.reason).toBe('consent-withdrawn');
    expect(e.repos.cases.archived.size).toBe(0);
  });

  it('a staff-rejected case is NOT reopened by a consent (only consent-withdrawn is)', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'reject', reason: 'Name does not match' } });
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'esign' } });
    expect((await e.repos.cases.get(userId))!.reason).toBe('staff-rejected');
  });
});

describe('S2: DELETE /kyc/data', () => {
  it('a case that is not verified: documents and the case are deleted, the PAN claim freed, audited; kept items say why', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    await e.uploadDoc(token, 'aadhaar', 'application/pdf');
    await e.uploadDoc(token, 'pan');
    const other = 'someone-else';
    await e.uploads.markUploaded(`kyc/${other}/pan-x.jpg`);
    const r = await e.call('DELETE', '/kyc/data', { token });
    expect(r.statusCode).toBe(200);
    expect(r.json.deleted).toEqual({ documents: 2, case: 'deleted' });
    expect(r.json.kept.map((k: { what: string }) => k.what)).toEqual(['consent-records', 'audit-log', 'paid-check-costs']);
    for (const k of r.json.kept) expect(k.reason).toMatch(/\w/);
    expect(e.uploads.keys()).toEqual([`kyc/${other}/pan-x.jpg`]);
    expect(await e.repos.cases.get(userId)).toBeNull();
    expect(e.repos.audit.all().filter((x) => x.action === 'kyc.data-deleted')).toHaveLength(1);
    // the PAN is free again (for this or another account)
    const t2 = await e.signIn();
    expect((await e.call('POST', '/kyc/start', { token: t2, body: startBody(PANS.fullPass) })).json.reason).not.toBe('pan-in-use');
    // the user can start over
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: null, next: 'start' });
  });

  it('a verified case: the regulatory KYC record is kept (minimised), encrypted PAN and typed details cleared', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    const r = await e.call('DELETE', '/kyc/data', { token });
    expect(r.json.deleted).toEqual({ documents: 0, case: 'minimised' });
    expect(r.json.kept.map((k: { what: string }) => k.what)).toContain('kyc-record');
    const rec = (await e.repos.cases.get(userId))!;
    expect(rec).toMatchObject({ status: 'verified', masks: { pan: 'XXXXXX001K' }, panEnc: '' });
    expect(rec.evidence.typed).toEqual({ firstName: '', lastName: '', dob: '' });
    expect(rec.evidence.kra).toBeUndefined();
    expect(JSON.stringify(rec)).not.toContain('Asha');
    expect(e.repos.audit.all().filter((x) => x.action === 'kyc.data-minimised')).toHaveLength(1);
  });

  it('no case yet: still answers and audits', async () => {
    const e = env();
    const token = await e.signIn();
    const r = await e.call('DELETE', '/kyc/data', { token });
    expect(r.json.deleted).toEqual({ documents: 0, case: 'none' });
    expect(e.repos.audit.all().filter((x) => x.action === 'kyc.data-deleted')).toHaveLength(1);
  });
});

describe('S11: /kyc/documents signing cap and linking', () => {
  it('at most 9 signings per user per IST day, counted per file', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const three = { files: [
      { kind: 'selfie', contentType: 'image/jpeg', size: 10 },
      { kind: 'aadhaar', contentType: 'image/png', size: 10 },
      { kind: 'pan', contentType: 'application/pdf', size: 10 },
    ] };
    for (let i = 0; i < MAX_SIGNINGS_PER_DAY / 3; i++) {
      expect((await e.call('POST', '/kyc/documents', { token, body: three })).statusCode).toBe(200);
    }
    const over = await e.call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'pan', contentType: 'image/png', size: 10 }] } });
    expect(over.statusCode).toBe(429);
    expect(over.json.error).toBe('limit_reached');
    expect(e.uploads.signed).toHaveLength(9);
    // the paid-check cap is separate
    expect(e.repos.costs.rows).toHaveLength(1);
    // the next IST day starts a fresh count (checked on the counter: a day jump also expires the token)
    const userId = await e.userIdOf(token);
    expect(await e.repos.costs.reserveSignings(userId, '2026-11-07', 3, MAX_SIGNINGS_PER_DAY)).toBe(true);
  });

  it('signed PUTs carry the pending tag; the case lists them until linked; never-uploaded ones expire', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const r = await e.call('POST', '/kyc/documents', { token, body: { files: [
      { kind: 'aadhaar', contentType: 'image/png', size: 10 }, { kind: 'pan', contentType: 'application/pdf', size: 10 },
    ] } });
    expect(r.json.uploads[0].headers['x-amz-tagging']).toBe('state=pending');
    expect((await e.repos.cases.get(userId))!.pendingUploads!.map((p) => p.uploadId)).toEqual(r.json.uploads.map((u: { uploadId: string }) => u.uploadId));
    e.uploads.markUploaded(e.uploads.signed[0]!.key); // only the Aadhaar was uploaded
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json.documents).toEqual(['aadhaar']);
    expect(e.uploads.states.get(e.uploads.signed[0]!.key)).toBe('linked');
    // the PAN signing is still pending (URL not expired yet)
    expect((await e.repos.cases.get(userId))!.pendingUploads).toHaveLength(1);
    e.clock.advance(10 * 60_000);
    await e.call('GET', '/kyc/status', { token });
    expect((await e.repos.cases.get(userId))!.pendingUploads).toBeUndefined();
    // a newer Aadhaar replaces the old one: the old one goes back to pending (lifecycle deletes it)
    const second = await e.uploadDoc(token, 'aadhaar');
    await e.call('GET', '/kyc/status', { token });
    expect(e.uploads.states.get(second.key)).toBe('linked');
    expect(e.uploads.states.get(e.uploads.signed[0]!.key)).toBe('pending');
    expect((await e.repos.cases.get(userId))!.documents!.aadhaar!.uploadId).toBe(second.uploadId);
  });

  it('a case that goes under review links its uploads straight away (pending lifecycle never deletes them)', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    const a = await e.uploadDoc(token, 'aadhaar');
    const p = await e.uploadDoc(token, 'pan');
    e.partner.setScenario(userId, 'unclear');
    // the selfie step sends the case to review; its own advance links the other uploads
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    expect((await e.repos.cases.get(userId))!.status).toBe('under-review');
    expect(e.uploads.states.get(a.key)).toBe('linked');
    expect(e.uploads.states.get(p.key)).toBe('linked');
    expect([...e.uploads.states.values()].every((s) => s === 'linked')).toBe(true);
  });

  it('hand-check and pan-in-use cases: all three uploads are tagged linked on the next case read, and status lists them', async () => {
    for (const kind of ['hand-check', 'pan-in-use'] as const) {
      const e = env();
      const holder = await e.signIn();
      const token = await e.signIn();
      if (kind === 'pan-in-use') await e.call('POST', '/kyc/start', { token: holder, body: startBody(PANS.fullPass) });
      const s = await e.call('POST', '/kyc/start', {
        token, body: startBody(PANS.fullPass, kind === 'hand-check' ? { deviceResult: 'under-review' } : {}),
      });
      expect(s.json.status, kind).toBe('under-review');
      expect(s.json.documents).toEqual([]);
      const keys = [];
      for (const k of ['selfie', 'aadhaar', 'pan'] as const) keys.push((await e.uploadDoc(token, k)).key);
      for (const k of keys) expect(e.uploads.states.get(k)).toBe('pending');
      const st = await e.call('GET', '/kyc/status', { token });
      expect(st.json.documents, kind).toEqual(['selfie', 'aadhaar', 'pan']);
      for (const k of keys) expect(e.uploads.states.get(k), kind).toBe('linked');
    }
  });

  it('a decided case gets no new signings', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    expect((await e.call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'pan', contentType: 'image/png', size: 10 }] } })).json.error)
      .toBe('decided');
  });
});

describe('S14: magic bytes vs the declared type', () => {
  it('sniffType knows JPEG, PNG and PDF only', () => {
    expect(sniffType(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(sniffType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffType(new TextEncoder().encode('%PDF-1.4'))).toBe('application/pdf');
    expect(sniffType(new TextEncoder().encode('<html>'))).toBeNull();
    expect(sniffType(new Uint8Array())).toBeNull();
  });

  it('a selfie whose bytes are not its declared JPEG is refused before the paid face match', async () => {
    const e = env();
    const token = await e.signIn();
    await fullKyc(e, token);
    const html = new TextEncoder().encode('<html><script>x</script>');
    const bad = await e.uploadDoc(token, 'selfie', 'image/jpeg', html);
    const r = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: bad.uploadId } });
    expect(r.statusCode).toBe(400);
    expect(r.json.error).toBe('upload_rejected');
    expect(e.partner.calls.faceMatch).toBe(0);
    // a PNG uploaded as JPEG is a mismatch too
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const wrong = await e.uploadDoc(token, 'selfie', 'image/jpeg', png);
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: wrong.uploadId } })).json.error).toBe('upload_rejected');
  });

  it('a document whose bytes do not match is marked rejected and never linked', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const bad = await e.uploadDoc(token, 'pan', 'application/pdf', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json.documents).toEqual([]);
    expect(st.json.rejectedDocuments).toEqual(['pan']);
    expect(e.uploads.states.get(bad.key)).toBe('pending');
  });
});

describe('S18: idempotency rows expire after 24 h; case rows never carry expiresAt', () => {
  it('a reused key replays inside 24 h and runs again after', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    const first = await e.call('POST', '/kyc/retry', { token, idem: 'retry-key-0001' });
    const again = await e.call('POST', '/kyc/retry', { token, idem: 'retry-key-0001' });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);
    const rec = [...e.repos.idempotency.items.values()][0]!;
    expect(rec.expiresAt).toBe(Math.floor(rec.createdAt / 1000) + 86_400);
    e.clock.advance(24 * 60 * 60_000 + 1000);
    const later = await e.call('POST', '/kyc/retry', { token, idem: 'retry-key-0001' });
    expect(later.headers['idempotent-replayed']).toBeUndefined();
  });

  it('no case write ever adds expiresAt (the table TTL would delete the case)', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    await e.svc.recordEsign(userId, 'done');
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'esign' } });
    for (const c of e.repos.cases.all()) expect(c).not.toHaveProperty('expiresAt');
    await grantAllConsents(e.repos, userId);
    expect(e.repos.idempotency.items.size).toBeGreaterThan(0);
    for (const r of e.repos.idempotency.items.values()) expect(typeof r.expiresAt).toBe('number');
  });
});
