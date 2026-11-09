import { describe, expect, it } from 'vitest';
import { AADHAAR_LAST4, env, fullKyc, PANS, RETURN_URL, startBody } from './helpers';

const REVIEWER = { authorization: 'Bearer staff-token-reviewer-0001' };

describe('KYC end to end (sign in → start → scenario → status)', () => {
  it('status before start: next is start, not eligible', async () => {
    const e = env();
    const token = await e.signIn();
    const r = await e.call('GET', '/kyc/status', { token });
    expect(r.statusCode).toBe(200);
    expect(r.json).toEqual({ status: null, path: null, reason: null, next: 'start', eligibleToInvest: false });
  });

  it('kra-validated: verified on start, no documents asked', async () => {
    const e = env();
    const token = await e.signIn();
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    expect(s.statusCode).toBe(200);
    expect(s.json).toMatchObject({
      status: 'verified', path: 'kra-validated', reason: 'kra-validated', next: 'none', eligibleToInvest: true,
      masks: { pan: 'XXXXXX001K', aadhaar: 'XXXX XXXX 1234' },
      checks: { 'kra-name': 'pass', 'kra-dob': 'pass' },
    });
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json.status).toBe('verified');
    expect(e.partner.calls.lookupKyc).toBe(1);
    expect(e.partner.calls.startAadhaar).toBe(0);
    expect(e.repos.costs.rows.map((r) => r.check)).toEqual(['kra-lookup']);
    // later steps are closed
    const a = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'otp', returnUrl: RETURN_URL } });
    expect(a.statusCode).toBe(409);
    expect((await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) })).json.error).toBe('decided');
  });

  it('kra-validated but the KRA name differs → full KYC', async () => {
    const e = env();
    e.partner.setPerson(PANS.kraValidated, { name: 'RAHUL RAO', dob: '1990-08-15' });
    const token = await e.signIn();
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    expect(s.json).toMatchObject({ status: 'pre-verified', path: 'full-kyc', next: 'aadhaar', checks: { 'kra-name': 'fail' } });
  });

  it('not-found → full KYC pass: aadhaar → pan (auto) → selfie → e-sign → verified → KRA upload', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId, aadhaar, afterPan } = await fullKyc(e, token);
    expect(aadhaar.json.redirectUrl).toMatch(/^https:\/\/fake-partner\.invalid\/digilocker\?/);
    expect(aadhaar.json.kyc.next).toBe('aadhaar');
    expect(afterPan.json).toMatchObject({ status: 'pre-verified', next: 'selfie', checks: { aadhaar: 'pass', pan: 'pass' } });
    expect(e.partner.calls.verifyPan).toBe(1);

    const selfie = await e.uploadSelfie(token);
    const f = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: selfie } });
    expect(f.statusCode).toBe(200);
    expect(f.json).toMatchObject({ next: 'esign', checks: { 'face-match': 'pass', liveness: 'pass' } });

    const es = await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    expect(es.statusCode).toBe(200);
    expect(es.json.redirectUrl).toMatch(/\/esign\?/);
    expect(es.json.kyc.next).toBe('esign');

    const done = await e.svc.recordEsign(userId, 'done'); // webhook
    expect(done).toMatchObject({ status: 'verified', path: 'full-kyc', reason: 'full-kyc-passed', next: 'none', eligibleToInvest: true });
    expect(e.partner.calls.uploadToKra).toBe(1);
    const rec = await e.repos.cases.get(userId);
    expect(rec!.partnerRefs.kraUpload).toMatch(/^kraup-/);
    expect(e.repos.costs.rows.map((r) => r.check)).toEqual(['kra-lookup', 'aadhaar', 'pan-verify', 'face-match', 'esign', 'kra-upload']);
    // every write bumped the version and wrote a system audit row
    // write order (rows in the same millisecond have no defined ts order)
    const audit = e.repos.audit.all().filter((r) => r.userId === userId);
    expect(audit.map((r) => r.action)).toEqual([
      'kyc.start', 'kyc.aadhaar-start', 'kyc.aadhaar-result', 'kyc.pan-check', 'kyc.selfie', 'kyc.esign-start', 'kyc.esign-result', 'kyc.kra-upload',
    ]);
    expect(rec!.version).toBe(audit.length);
    expect(audit.every((r) => r.actor === 'system')).toBe(true);
  });

  it('Aadhaar OTP mode returns a challenge ref, no redirect', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const a = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'otp', returnUrl: 'wealthfire://kyc' } });
    expect(a.statusCode).toBe(200);
    expect(a.json.redirectUrl).toBeUndefined();
    expect(a.json.challengeRef).toMatch(/^aad-/);
  });

  it('unclear (PAN name partial) → under-review; user steps closed; staff approve → verified', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId, afterPan } = await fullKyc(e, token, PANS.unclear);
    expect(afterPan.json).toMatchObject({ status: 'under-review', reason: 'check-unclear', next: 'wait', unclear: ['pan-name'] });
    const selfie = await e.uploadSelfie(token);
    expect((await e.call('POST', '/kyc/selfie', { token, body: { uploadId: selfie } })).json.error).toBe('wrong_step');
    expect((await e.call('POST', '/kyc/start', { token, body: startBody(PANS.unclear) })).json.error).toBe('already_started');

    const list = await e.call('GET', '/review/cases', { headers: REVIEWER });
    expect(list.statusCode).toBe(200);
    expect(list.json.items.map((c: { id: string }) => c.id)).toEqual([userId]);
    const ok = await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'approve', note: 'name ok' } });
    expect(ok.statusCode).toBe(200);
    // the approval triggered the KRA upload right away (system action, audited)
    expect(e.partner.calls.uploadToKra).toBe(1);
    expect(ok.json.case).toMatchObject({ status: 'verified', reason: 'staff-approved' });
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'verified', reason: 'staff-approved', next: 'none', eligibleToInvest: true });
    expect(e.reviewAudit().map((a) => a.action)).toEqual(['review.approve']);
    const trail = e.repos.audit.all().filter((r) => r.userId === userId);
    expect(trail.slice(-2).map((a) => [a.actor, a.action])).toEqual([['staff:staff-1', 'review.approve'], ['system', 'kyc.kra-upload']]);
    expect((await e.repos.cases.get(userId))!.partnerRefs.kraUpload).toMatch(/^kraup-/);
    // retry-safe: later status reads do not upload again
    await e.call('GET', '/kyc/status', { token });
    expect(e.partner.calls.uploadToKra).toBe(1);
  });

  it('staff approve: a KRA upload that times out stays pending and is retried by GET /kyc/status', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    e.partner.failNext('uploadToKra', 2);
    const ok = await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'approve' } });
    expect(ok.statusCode).toBe(200); // the approval stands
    expect(e.partner.calls.uploadToKra).toBe(2);
    expect((await e.repos.cases.get(userId))!).toMatchObject({ status: 'verified', next: 'kra-upload' });
    expect((await e.repos.cases.get(userId))!.partnerRefs.kraUpload).toBeUndefined();
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'verified', next: 'none' });
    expect(e.partner.calls.uploadToKra).toBe(3);
    expect((await e.repos.cases.get(userId))!.partnerRefs.kraUpload).toMatch(/^kraup-/);
  });

  it('staff reject: no KRA upload, next none', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    const r = await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'reject', reason: 'Name does not match' } });
    expect(r.statusCode).toBe(200);
    expect(e.partner.calls.uploadToKra).toBe(0);
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: 'rejected', reason: 'staff-rejected', next: 'none' });
  });

  it('unclear (low face score) → under-review check-unclear', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    e.partner.setScenario(userId, 'unclear');
    await fullKyc(e, token);
    const f = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    expect(f.json).toMatchObject({ status: 'under-review', reason: 'check-unclear', next: 'wait', unclear: ['face-match'] });
    expect(f.json.checks['face-match']).toBe('unclear');
  });

  it('reject (PAN invalid at Income Tax) → rejected', async () => {
    const e = env();
    const token = await e.signIn();
    const { afterPan } = await fullKyc(e, token, PANS.reject);
    expect(afterPan.json).toMatchObject({ status: 'rejected', reason: 'pan-invalid', next: 'none', eligibleToInvest: false });
  });

  it('reject (non-individual PAN) at start, without a paid lookup', async () => {
    const e = env();
    const token = await e.signIn();
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.company) });
    expect(s.json).toMatchObject({ status: 'rejected', reason: 'pan-not-individual' });
    expect(e.partner.calls.lookupKyc).toBe(0);
    expect(e.repos.costs.rows).toEqual([]);
  });

  it('reject (Aadhaar last 4 differs from the OTP-verified last 4)', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    expect(await e.svc.recordAadhaar(userId, { verified: true, last4: '9999' })).toMatchObject({ status: 'rejected', reason: 'aadhaar-mismatch' });
  });

  it('device hand check → under-review for staff, no paid lookup', async () => {
    const e = env();
    const token = await e.signIn();
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated, { deviceResult: 'under-review' }) });
    expect(s.json).toMatchObject({ status: 'under-review', path: 'hand-check', reason: 'device-hand-check', next: 'wait' });
    expect(e.partner.calls.lookupKyc).toBe(0);
    // documents can still be uploaded for the reviewer
    const d = await e.call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'pan', contentType: 'application/pdf', size: 1000 }] } });
    expect(d.statusCode).toBe(200);
  });

  it('timeout: KRA lookup times out after retries → under-review partner-timeout; retry verifies', async () => {
    const e = env();
    const token = await e.signIn();
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect(s.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout', next: 'wait', unclear: ['kra'] });
    expect(e.partner.calls.lookupKyc).toBe(2); // 2 attempts
    expect(e.repos.costs.rows.length).toBe(2); // each attempt logged
    // partner is back: the system may now verify the under-review case
    e.partner.setScenario(PANS.timeout, 'kra-validated');
    const r = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect(r.statusCode).toBe(200);
    expect(r.json).toMatchObject({ status: 'verified', path: 'kra-validated' });
  });

  it('timeout: a retry that times out again stays partner-timeout', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    const r = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect(r.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
  });

  it('timeout: one KRA timeout then success inside the retries → no review', async () => {
    const e = env();
    e.partner.failNext('lookupKyc', 1);
    const token = await e.signIn();
    const s = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated) });
    expect(s.json.status).toBe('verified');
  });

  it('timeout: PAN check timeout → partner-timeout; retry via start continues the full KYC', async () => {
    const e = env();
    e.partner.failNext('verifyPan', 2);
    const token = await e.signIn();
    const { afterPan } = await fullKyc(e, token);
    expect(afterPan.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout', unclear: ['pan'] });
    const r = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(r.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout', next: 'selfie' });
    const f = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    expect(f.json.next).toBe('esign');
  });

  it('timeout: face match timeout → retake the selfie → continues', async () => {
    const e = env();
    const token = await e.signIn();
    await fullKyc(e, token);
    e.partner.failNext('faceMatch', 2);
    const id = await e.uploadSelfie(token);
    const f1 = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } });
    expect(f1.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout', unclear: ['face-match'] });
    const f2 = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: id } });
    expect(f2.json).toMatchObject({ status: 'under-review', reason: 'partner-timeout', next: 'esign' });
  });

  it('timeout: e-sign timeout from the webhook → e-sign can be restarted → verified', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: await e.uploadSelfie(token) } });
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    expect(await e.svc.recordEsign(userId, 'timeout')).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
    const again = await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    expect(again.statusCode).toBe(200);
    expect(await e.svc.recordEsign(userId, 'done')).toMatchObject({ status: 'verified', next: 'none' });
  });

  it('timeout: Aadhaar timeout from the webhook → Aadhaar can be restarted', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    expect(await e.svc.recordAadhaar(userId, 'timeout')).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
    const a = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    expect(a.statusCode).toBe(200);
    expect(a.json.kyc).toMatchObject({ status: 'under-review', reason: 'partner-timeout', next: 'aadhaar' });
    expect(await e.svc.recordAadhaar(userId, { verified: true, last4: AADHAAR_LAST4 })).toMatchObject({ next: 'selfie' });
  });

  it('starting Aadhaar while the partner times out → 503, case unchanged, no review', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    e.partner.failNext('startAadhaar', 2);
    const a = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    expect(a.statusCode).toBe(503);
    expect(a.json.error).toBe('partner_unavailable');
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: 'pre-verified', next: 'aadhaar' });
  });

  it('a webhook write that only updates evidence: status re-derives next and runs the PAN check', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl: RETURN_URL } });
    const rec = (await e.repos.cases.get(userId))!;
    // like src/webhook: evidence + version bumped, `next` left as it was
    await e.repos.cases.put({ ...rec, evidence: { ...rec.evidence, aadhaar: { verified: true, last4: AADHAAR_LAST4 } }, version: rec.version + 1 });
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json).toMatchObject({ status: 'pre-verified', next: 'selfie', checks: { aadhaar: 'pass', pan: 'pass' } });
    expect(e.partner.calls.verifyPan).toBe(1);
    await e.call('GET', '/kyc/status', { token });
    expect(e.partner.calls.verifyPan).toBe(1);
  });

  it('webhook results for a step that is not open are refused', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await expect(e.svc.recordAadhaar(userId, { verified: true, last4: AADHAAR_LAST4 })).rejects.toMatchObject({ code: 'not_found' });
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    // aadhaar not started yet (no partner ref)
    await expect(e.svc.recordAadhaar(userId, { verified: true, last4: AADHAAR_LAST4 })).rejects.toMatchObject({ code: 'wrong_step' });
    await expect(e.svc.recordEsign(userId, 'done')).rejects.toMatchObject({ code: 'wrong_step' });
    await expect(e.svc.recordAadhaar(userId, { verified: true, last4: '12345' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('a staff decision between read and write is not overwritten (optimistic version)', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    const uploadId = await e.uploadSelfie(token);
    const rec = (await e.repos.cases.get(userId))!;
    // simulate staff rejecting the case meanwhile
    await e.repos.cases.put({ ...rec, status: 'rejected', reason: 'staff-rejected', version: rec.version + 1 });
    const f = await e.call('POST', '/kyc/selfie', { token, body: { uploadId } });
    expect(f.statusCode).toBe(409);
    expect((await e.repos.cases.get(userId))!.status).toBe('rejected');
  });
});

describe('/kyc/start input', () => {
  it('rejects bad names, DOB, PAN shape, Aadhaar last 4 and device result', async () => {
    const e = env();
    const token = await e.signIn();
    const bad = [
      startBody(PANS.fullPass, { firstName: '' }),
      startBody(PANS.fullPass, { lastName: '123' }),
      startBody(PANS.fullPass, { firstName: 'x'.repeat(101) }),
      startBody(PANS.fullPass, { dob: '31/02/1990' }),
      startBody(PANS.fullPass, { dob: 19900815 }),
      startBody('ABCP0001K'),
      startBody('ABCXR0001K'),
      startBody(PANS.fullPass, { aadhaarLast4: '123' }),
      startBody(PANS.fullPass, { aadhaarLast4: '234567891234' }),
      startBody(PANS.fullPass, { deviceResult: 'verified' }),
      '{not json',
      [1, 2],
    ];
    for (const body of bad) {
      const r = await e.call('POST', '/kyc/start', { token, body });
      expect(r.statusCode).toBe(400);
      expect(r.json.error).toBe('bad_request');
    }
    expect(e.partner.calls.lookupKyc).toBe(0);
  });

  it('accepts a lower-case PAN and yyyy-mm-dd DOB', async () => {
    const e = env();
    const token = await e.signIn();
    const r = await e.call('POST', '/kyc/start', { token, body: startBody(PANS.kraValidated.toLowerCase(), { dob: '1990-08-15' }) });
    expect(r.json.status).toBe('verified');
  });
});

describe('/kyc/documents', () => {
  it('signs PUTs under kyc/<userId>/ with exact size and type, 5-minute expiry', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const r = await e.call('POST', '/kyc/documents', {
      token,
      body: { files: [
        { kind: 'selfie', contentType: 'image/png', size: 5000 },
        { kind: 'aadhaar', contentType: 'application/pdf', size: 10 * 1024 * 1024 },
        { kind: 'pan', contentType: 'image/jpeg', size: 1 },
      ] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json.uploads.map((u: { kind: string }) => u.kind)).toEqual(['selfie', 'aadhaar', 'pan']);
    for (const u of r.json.uploads) {
      expect(u.method).toBe('PUT');
      expect(u.uploadId).toMatch(new RegExp(`^${u.kind}-[0-9a-f-]{36}\\.(png|pdf|jpg)$`));
      expect(u.maxBytes).toBe(10 * 1024 * 1024);
    }
    expect(e.uploads.signed.map((s) => s.key.startsWith(`kyc/${userId}/`))).toEqual([true, true, true]);
    expect(e.uploads.signed[1]).toMatchObject({ contentType: 'application/pdf', contentLength: 10 * 1024 * 1024, expiresInSec: 300 });
  });

  it('refuses >10 MB, other types, PDF selfies, duplicate kinds, unknown kinds, no case', async () => {
    const e = env();
    const token = await e.signIn();
    const none = await e.call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'pan', contentType: 'image/png', size: 10 }] } });
    expect(none.statusCode).toBe(404);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const bad = [
      [{ kind: 'pan', contentType: 'image/png', size: 10 * 1024 * 1024 + 1 }],
      [{ kind: 'pan', contentType: 'image/gif', size: 10 }],
      [{ kind: 'selfie', contentType: 'application/pdf', size: 10 }],
      [{ kind: 'pan', contentType: 'image/png', size: 10 }, { kind: 'pan', contentType: 'image/png', size: 10 }],
      [{ kind: 'passport', contentType: 'image/png', size: 10 }],
      [{ kind: 'pan', contentType: 'image/png', size: 0 }],
      [{ kind: 'pan', contentType: 'image/png', size: 1.5 }],
      [],
      'x',
    ];
    for (const files of bad) {
      const r = await e.call('POST', '/kyc/documents', { token, body: { files } });
      expect(r.statusCode).toBe(400);
    }
    expect(e.uploads.signed).toEqual([]);
  });

  it('/kyc/selfie refuses an id that was never uploaded or is not a selfie id', async () => {
    const e = env();
    const token = await e.signIn();
    await fullKyc(e, token);
    const notUploaded = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: 'selfie-11111111-1111-4111-8111-111111111111.jpg' } });
    expect(notUploaded.json.error).toBe('upload_missing');
    for (const uploadId of ['../other-user/selfie-1.jpg', 'pan-11111111-1111-4111-8111-111111111111.jpg', 'selfie-x.pdf', 42]) {
      const r = await e.call('POST', '/kyc/selfie', { token, body: { uploadId } });
      expect(r.statusCode).toBe(400);
    }
    expect(e.partner.calls.faceMatch).toBe(0);
  });
});

describe('return URLs', () => {
  it('only app origins and the app scheme', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    for (const returnUrl of [
      'https://evil.example/x', 'https://nitishsana.github.io.evil.example/', 'javascript:alert(1)', '', 5,
      // same host, outside the app: the allow-list is the app path, not the whole github.io host
      'https://nitishsana.github.io/other-app/', 'https://nitishsana.github.io/wealthfire-evil/', 'http://127.0.0.1:5181/',
    ]) {
      const r = await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'digilocker', returnUrl } });
      expect(r.statusCode).toBe(400);
    }
    expect((await e.call('POST', '/kyc/aadhaar', { token, body: { mode: 'sms', returnUrl: RETURN_URL } })).statusCode).toBe(400);
    expect(e.partner.calls.startAadhaar).toBe(0);
  });
});
