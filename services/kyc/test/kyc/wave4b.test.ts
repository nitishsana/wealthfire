// Wave 4b (G-KYC): S#1 presign, F1/S#4 linking on every path, S#5/F4 withdraw + delete, S#9
// conditional PUT, S#11 consent per case, S#14 IP hash, F9 auto-retry cap, F3 verified withdraw.
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { MAX_AUTO_RETRIES_PER_DAY } from '../../src/kyc/service';
import { createUploadS3Client, S3UploadSigner } from '../../src/kyc/uploads';
import { env, fullKyc, PANS, RETURN_URL, startBody, type Env } from './helpers';

const REVIEWER = { authorization: 'Bearer staff-token-reviewer-0001' };
const DUMMY = { region: 'ap-south-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'dummy-secret-not-real' } };
const SIGN_INPUT = { key: 'kyc/u1/pan-00000000-0000-0000-0000-000000000000.pdf', contentType: 'application/pdf', contentLength: 1234, expiresInSec: 300 };

/** Query parameters of a presigned URL (names lower-cased). */
function query(url: string): Map<string, string> {
  const u = new URL(url);
  return new Map([...u.searchParams.entries()].map(([k, v]) => [k.toLowerCase(), v]));
}

describe('S#1 + S#9: a REAL presigned upload URL (dummy credentials, signed locally, no AWS call)', () => {
  for (const [label, client] of [
    ['a default shared client (the signer switches to WHEN_REQUIRED itself)', () => new S3Client(DUMMY)],
    ['createUploadS3Client', () => createUploadS3Client(DUMMY)],
  ] as const) {
    it(`${label}: SignedHeaders has x-amz-tagging and if-none-match; no x-amz-checksum-*`, async () => {
      const signer = new S3UploadSigner(client(), 'docs-bucket');
      const { url, headers } = await signer.signPut(SIGN_INPUT);
      const q = query(url);
      const signed = (q.get('x-amz-signedheaders') ?? '').split(';');
      expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host', 'if-none-match', 'x-amz-tagging']));
      // the tag is a signed HEADER, not hoisted into the query
      expect(q.has('x-amz-tagging')).toBe(false);
      for (const k of q.keys()) expect(k).not.toMatch(/^x-amz-(sdk-)?checksum/);
      expect(q.get('x-amz-credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/ap-south-1\/s3\/aws4_request$/);
      expect(q.get('x-amz-expires')).toBe('300');
      // what the app must send: exactly the signed headers
      expect(headers).toEqual({
        'content-type': 'application/pdf', 'content-length': '1234', 'x-amz-tagging': 'state=pending', 'if-none-match': '*',
      });
    });
  }

  it('/kyc/documents hands the app the conditional-write header with each upload', async () => {
    const e = env();
    const token = await e.signIn();
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    const r = await e.call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'pan', contentType: 'image/png', size: 10 }] } });
    expect(r.json.uploads[0].headers).toMatchObject({ 'if-none-match': '*', 'x-amz-tagging': 'state=pending' });
  });
});

/** All three documents of the case are linked (case.documents) and tagged linked in S3. */
async function expectAllLinked(e: Env, userId: string, keys: string[]): Promise<void> {
  const rec = (await e.repos.cases.get(userId))!;
  for (const k of ['selfie', 'aadhaar', 'pan'] as const) expect(rec.documents?.[k]?.state, k).toBe('linked');
  for (const key of keys) expect(e.uploads.states.get(key), key).toBe('linked');
  expect(rec.pendingUploads).toBeUndefined();
}

describe('F1/S#4: uploads are linked on every path, also once the case is verified', () => {
  it('selfie pass -> e-sign start -> e-sign done: all 3 linked (Aadhaar arrives before e-sign, PAN after it)', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    // the app signs all three, then uploads; the PUTs land at different times
    const r = await e.call('POST', '/kyc/documents', { token, body: { files: [
      { kind: 'selfie', contentType: 'image/jpeg', size: 10 }, { kind: 'aadhaar', contentType: 'image/png', size: 10 },
      { kind: 'pan', contentType: 'application/pdf', size: 10 },
    ] } });
    const [selfieKey, aadhaarKey, panKey] = e.uploads.signed.slice(-3).map((s) => s.key) as [string, string, string];
    e.uploads.markUploaded(selfieKey);
    const sf = await e.call('POST', '/kyc/selfie', { token, body: { uploadId: r.json.uploads[0].uploadId } });
    expect(sf.json.next).toBe('esign');
    e.uploads.markUploaded(aadhaarKey);
    expect((await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } })).statusCode).toBe(200);
    expect(e.uploads.states.get(aadhaarKey)).toBe('linked'); // linked by the e-sign start
    e.uploads.markUploaded(panKey);
    const done = await e.svc.recordEsign(userId, 'done'); // webhook: the case becomes verified
    expect(done).toMatchObject({ status: 'verified', documents: ['selfie', 'aadhaar', 'pan'] });
    await expectAllLinked(e, userId, [selfieKey, aadhaarKey, panKey]);
  });

  it('a verified case with no follow-up left still links an upload that lands later (status read)', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    const a = await e.uploadDoc(token, 'aadhaar');
    const sign = await e.call('POST', '/kyc/documents', { token, body: { files: [{ kind: 'pan', contentType: 'image/jpeg', size: 10 }] } });
    expect(sign.statusCode).toBe(200);
    const panKey = e.uploads.signed.at(-1)!.key;
    const selfie = await e.uploadSelfie(token);
    const selfieKey = e.uploads.signed.at(-1)!.key;
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: selfie } });
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    expect(await e.svc.recordEsign(userId, 'done')).toMatchObject({ status: 'verified', next: 'none' }); // KRA upload done too
    e.uploads.markUploaded(panKey); // the PAN PUT lands after the case is decided
    const st = await e.call('GET', '/kyc/status', { token });
    expect(st.json.documents).toEqual(['selfie', 'aadhaar', 'pan']);
    await expectAllLinked(e, userId, [selfieKey, a.key, panKey]);
  });

  it('linkDocuments (the review routes hook) links an under-review case\u2019s uploads; never a rejected one', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    const keys = [];
    for (const k of ['selfie', 'aadhaar', 'pan'] as const) keys.push((await e.uploadDoc(token, k)).key);
    await e.svc.linkDocuments(userId);
    await expectAllLinked(e, userId, keys);
    // a rejected case: nothing is linked
    const t2 = await e.signIn();
    const u2 = await e.userIdOf(t2);
    await fullKyc(e, t2);
    const late = await e.uploadDoc(t2, 'pan');
    await e.call('POST', '/kyc/consent/withdraw', { token: t2, body: { purpose: 'esign' } });
    await e.svc.linkDocuments(u2);
    expect(e.uploads.states.get(late.key)).toBeUndefined(); // deleted by the withdrawal, never linked
  });
});

describe('S#5/F4: withdraw and DELETE /kyc/data delete what is not kept', () => {
  it('withdraw on a NON-verified case deletes kyc/<userId>/ and blanks the encrypted PAN and typed details', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    await e.uploadDoc(token, 'aadhaar');
    await e.uploadDoc(token, 'pan');
    await e.call('GET', '/kyc/status', { token }); // links both
    e.uploads.markUploaded('kyc/someone-else/pan-x.jpg');
    const w = await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'face-match' } });
    expect(w.json.kyc).toMatchObject({ status: 'rejected', reason: 'consent-withdrawn', documents: [] });
    expect(e.uploads.keys()).toEqual(['kyc/someone-else/pan-x.jpg']);
    const rec = (await e.repos.cases.get(userId))!;
    expect(rec.panEnc).toBe('');
    expect(rec.evidence.typed).toEqual({ firstName: '', lastName: '', dob: '' });
    expect(rec.evidence.otpAadhaarLast4).toBe('');
    expect(rec.evidence.kra).toBeUndefined();
    expect(rec.evidence.aadhaar).toBeUndefined();
    expect(rec.documents).toBeUndefined();
    expect(rec.pendingUploads).toBeUndefined();
    expect(rec.masks.pan).toBe('XXXXXX002K'); // masks stay
    expect(JSON.stringify(rec)).not.toContain('Asha');
    // the apps withdraw every purpose in turn: the case is written once, the delete repeats safely
    for (const purpose of ['esign', 'pan-check', 'digilocker'] as const) {
      expect((await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose } })).statusCode).toBe(200);
    }
    expect(e.repos.audit.all().filter((r) => r.action === 'kyc.consent-withdrawn')).toHaveLength(1);
  });

  it('a staff-rejected case is minimised too on withdraw (not kept by the retention rule); its reason stays', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    await e.uploadDoc(token, 'pan');
    await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'reject', reason: 'Name does not match' } });
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'esign' } });
    const rec = (await e.repos.cases.get(userId))!;
    expect(rec).toMatchObject({ status: 'rejected', reason: 'staff-rejected', panEnc: '' });
    expect(e.uploads.keys().filter((k) => k.startsWith(`kyc/${userId}/`))).toEqual([]);
  });

  it('F3: withdraw on a verified case still waiting for e-sign: recorded, KYC stays, the e-sign waits (consent-required)', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    for (const k of ['selfie', 'aadhaar', 'pan'] as const) await e.uploadDoc(token, k);
    const ok = await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'approve' } });
    expect(ok.statusCode).toBe(200);
    const docsBefore = e.uploads.keys().filter((k) => k.startsWith(`kyc/${userId}/`)).sort();
    const w = await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'esign' } });
    expect(w.json.kyc).toMatchObject({ status: 'verified', reason: 'staff-approved', next: 'esign', eligibleToInvest: false });
    expect((await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } })).json.error).toBe('consent-required');
    expect((await e.call('GET', '/kyc/status', { token })).json).toMatchObject({ status: 'verified', next: 'esign', eligibleToInvest: false });
    // the verified record and its documents are kept
    expect((await e.repos.cases.get(userId))!.panEnc).not.toBe('');
    expect(e.uploads.keys().filter((k) => k.startsWith(`kyc/${userId}/`)).sort()).toEqual(docsBefore);
    expect(e.repos.consents.rows.at(-1)).toMatchObject({ purpose: 'esign', action: 'withdrawn' });
  });

  it('F3: withdraw kra-upload on a verified, e-signed case: the KRA upload waits (no paid call), the KYC stays', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token, PANS.unclear);
    for (const k of ['selfie', 'aadhaar', 'pan'] as const) await e.uploadDoc(token, k);
    expect((await e.call('POST', `/review/cases/${userId}`, { headers: REVIEWER, body: { action: 'approve' } })).statusCode).toBe(200);
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    const w = await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'kra-upload' } });
    expect(w.json.kyc).toMatchObject({ status: 'verified' });
    expect(await e.svc.recordEsign(userId, 'done')).toMatchObject({ status: 'verified', next: 'kra-upload', eligibleToInvest: true });
    await e.call('GET', '/kyc/status', { token });
    expect(e.partner.calls.uploadToKra).toBe(0);
    expect((await e.repos.cases.get(userId))!.status).toBe('verified');
  });

  it('DELETE /kyc/data also deletes archived cases (arch#<userId>#*)', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'esign' } });
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'pan-check' } }); // archives case 1
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.fullPass) });
    expect(e.repos.cases.archived.size).toBe(1);
    const r = await e.call('DELETE', '/kyc/data', { token });
    expect(r.json.deleted).toEqual({ documents: 0, case: 'deleted', archived: 1 });
    expect(e.repos.cases.archived.size).toBe(0);
    expect(await e.repos.cases.get(userId)).toBeNull();
    // consent rows are never deleted; a new case needs fresh ones
    expect(e.repos.consents.rows.length).toBeGreaterThan(0);
    expect(await e.svc.hasConsent(userId, 'pan-check')).toBe(false);
  });

  it('DELETE /kyc/data on a verified case keeps only the documents the case references', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await fullKyc(e, token);
    const oldAadhaar = await e.uploadDoc(token, 'aadhaar');
    await e.call('GET', '/kyc/status', { token });
    const newAadhaar = await e.uploadDoc(token, 'aadhaar'); // replaces the old one
    const pan = await e.uploadDoc(token, 'pan');
    const selfie = await e.uploadSelfie(token);
    const selfieKey = e.uploads.signed.at(-1)!.key;
    await e.call('POST', '/kyc/selfie', { token, body: { uploadId: selfie } });
    await e.call('POST', '/kyc/esign', { token, body: { returnUrl: RETURN_URL } });
    await e.svc.recordEsign(userId, 'done');
    expect((await e.repos.cases.get(userId))!.status).toBe('verified');
    e.uploads.markUploaded(`kyc/${userId}/pan-stray.jpg`); // an object the case never referenced
    const r = await e.call('DELETE', '/kyc/data', { token });
    expect(r.json.deleted).toEqual({ documents: 2, case: 'minimised', archived: 0 });
    expect(e.uploads.keys().sort()).toEqual([newAadhaar.key, pan.key, selfieKey].sort());
    expect(e.uploads.keys()).not.toContain(oldAadhaar.key);
  });
});

describe('S#14: no raw IP in consent or audit rows', () => {
  it('rows carry hmacLookup(ip) only', async () => {
    const e = env();
    const token = await e.signIn();
    const { userId } = await fullKyc(e, token);
    await e.call('POST', '/kyc/consent', { token, body: { purpose: 'esign' } });
    await e.call('POST', '/kyc/consent/withdraw', { token, body: { purpose: 'esign' } });
    await e.call('DELETE', '/kyc/data', { token });
    const rows = [...e.repos.audit.all().filter((r) => r.userId === userId), ...e.repos.consents.rows.filter((r) => r.userId === userId)];
    expect(JSON.stringify(rows)).not.toContain('203.0.113.7');
    for (const r of rows) expect(r).not.toHaveProperty('ip');
    const hashes = new Set(rows.map((r) => (r as { ipHash?: string }).ipHash).filter(Boolean));
    expect(hashes.size).toBe(1); // the same IP always hashes the same
  });
});

describe('F9: GET /kyc/status auto-retries at most 3 times per India day, one attempt each', () => {
  it('caps the paid auto-retries per day and starts again the next India day', async () => {
    const e = env();
    const token = await e.signIn();
    const userId = await e.userIdOf(token);
    await e.call('POST', '/kyc/start', { token, body: startBody(PANS.timeout) });
    expect(e.partner.calls.lookupKyc).toBe(2); // the start's own call: first try + one retry
    for (let i = 1; i <= MAX_AUTO_RETRIES_PER_DAY; i++) {
      await e.svc.status(userId);
      expect(e.partner.calls.lookupKyc).toBe(2 + i); // a single attempt each
      e.clock.advance(10 * 60_000);
    }
    await e.svc.status(userId);
    e.clock.advance(10 * 60_000);
    await e.svc.status(userId);
    expect(e.partner.calls.lookupKyc).toBe(2 + MAX_AUTO_RETRIES_PER_DAY); // cap reached: the step waits
    expect(await e.svc.status(userId)).toMatchObject({ status: 'under-review', reason: 'partner-timeout' });
    // the user can still retry on purpose (POST /kyc/retry is not capped by F9)
    await e.svc.retry(userId);
    expect(e.partner.calls.lookupKyc).toBe(4 + MAX_AUTO_RETRIES_PER_DAY);
    // next India day (clock 17:30 IST + 7 h = 00:30 IST)
    e.clock.advance(7 * 60 * 60_000);
    await e.svc.status(userId);
    expect(e.partner.calls.lookupKyc).toBe(5 + MAX_AUTO_RETRIES_PER_DAY);
    expect((await e.repos.cases.get(userId))!.autoRetries).toMatchObject({ count: 1 });
  });
});
