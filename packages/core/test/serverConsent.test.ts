// Wave 4 client behaviour: consent before each paid step, retry after a partner timeout, all three
// documents, withdraw consent / delete data, the shared reason texts and the web session rules.
import { describe, expect, it } from 'vitest';
import {
  CONSENT_PURPOSES,
  CONSENT_TEXT,
  FEATURES,
  KYC_REASON_TEXT,
  KYC_TEXT,
  ServerError,
  ServerKycClient,
  STEP_CONSENT,
  hasKycCase,
  isConsentRequired,
  kycDocsNeeded,
  kycFinalLabel,
  kycFinalReason,
  kycReasonText,
  kycRejectedDocs,
  kycUploadAgainText,
  kycWithdrawBody,
  kycWithdrawDone,
  needsSignIn,
  serverEligibleToInvest,
  showDemoReviewer,
  toKycStatusView,
  type DocKind,
  type KycStatusView,
  type ServerFetchInit,
  type TokenStore,
} from '../src';

const BASE = 'https://api.example.test';
interface Call { url: string; init: ServerFetchInit }
type Reply = { status: number; body?: unknown } | 'network-error';

/** Fake fetch: replies in order per "METHOD path" (the last reply repeats), records every call. */
function fakeFetch(routes: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: ServerFetchInit) => {
    calls.push({ url, init });
    const q = routes[`${init.method} ${url.slice(BASE.length)}`];
    const r = q && q.length > 1 ? q.shift()! : q?.[0];
    if (!r) return { status: 404, text: async () => JSON.stringify({ error: 'not_found' }) };
    if (r === 'network-error') throw new TypeError('failed');
    return { status: r.status, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  const paths = () => calls.map((c) => `${c.init.method} ${c.url.slice(BASE.length)}`);
  const bodies = (path: string) => calls.filter((c) => c.url.endsWith(path)).map((c) => JSON.parse(c.init.body ?? '{}'));
  return { fetch, calls, paths, bodies };
}

function memTokens(access: string | null = 'A1'): TokenStore & { access: string | null } {
  const s = { access, async get() { return s.access; }, async set(v: string | null) { s.access = v; } };
  return s;
}

const ok = { status: 200, body: { ok: true } };
const view = (over: Record<string, unknown> = {}) => ({ status: 'pre-verified', path: null, reason: 'in-progress', next: 'aadhaar', eligibleToInvest: false, ...over });
let n = 0;
const newKey = () => `k-${++n}`;
const client = (f: ReturnType<typeof fakeFetch>, tokens = memTokens()) => new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens, newKey });
const input = { firstName: 'Asha', lastName: 'Rao', dob: '1990-01-31', pan: 'ABCPE1234F', aadhaarLast4: '2346', deviceStatus: 'pre-verified' as const };

describe('R6 reason texts (shared in core)', () => {
  it('match the contract exactly', () => {
    expect(KYC_REASON_TEXT['pan-in-use']).toBe('We need to check your PAN by hand.');
    expect(KYC_REASON_TEXT['partner-timeout']).toBe('Our partner is slow. Tap Try again.');
    expect(KYC_REASON_TEXT['hand-check']).toBe('We\u2019re checking your documents by hand.');
    expect(KYC_REASON_TEXT['consent-withdrawn']).toBe('You withdrew consent, so we stopped your KYC.');
  });

  it('device-hand-check shows the same text as hand-check', () => {
    expect(kycReasonText('device-hand-check')).toBe(kycReasonText('hand-check'));
  });

  it('unknown or missing codes show nothing (no server value is echoed)', () => {
    expect(kycReasonText('ABCPE1234F')).toBeUndefined();
    expect(kycReasonText('toString')).toBeUndefined();
    expect(kycReasonText(null)).toBeUndefined();
    expect(kycReasonText('')).toBeUndefined();
  });
});

describe('consent before each paid step', () => {
  it('startKyc posts pan-check consent, then /kyc/start', async () => {
    const f = fakeFetch({ 'POST /kyc/consent': [ok], 'POST /kyc/start': [{ status: 200, body: view() }] });
    const c = client(f);
    await c.startKyc(input);
    expect(f.paths()).toEqual(['POST /kyc/consent', 'POST /kyc/start']);
    expect(f.bodies('/kyc/consent')).toEqual([{ purpose: 'pan-check' }]);
    expect(f.calls[0]!.init.headers.authorization).toBe('Bearer A1');
    expect(f.calls[0]!.init.headers['idempotency-key']).toBeUndefined();
    expect(c.hasConsent('pan-check')).toBe(true);
  });

  it('startAadhaar: digilocker or aadhaar-otp consent by mode', async () => {
    const f = fakeFetch({ 'POST /kyc/consent': [ok], 'POST /kyc/aadhaar': [{ status: 200, body: { redirectUrl: 'https://p.test/d', kyc: view() } }] });
    const c = client(f);
    await c.startAadhaar('digilocker', 'https://app.test/r');
    await c.startAadhaar('otp', 'https://app.test/r');
    expect(f.bodies('/kyc/consent')).toEqual([{ purpose: 'digilocker' }, { purpose: 'aadhaar-otp' }]);
    expect(f.paths()).toEqual(['POST /kyc/consent', 'POST /kyc/aadhaar', 'POST /kyc/consent', 'POST /kyc/aadhaar']);
  });

  it('submitSelfie: face-match consent first', async () => {
    const f = fakeFetch({ 'POST /kyc/consent': [ok], 'POST /kyc/selfie': [{ status: 200, body: view({ next: 'esign' }) }] });
    await client(f).submitSelfie('selfie-x.jpg');
    expect(f.paths()).toEqual(['POST /kyc/consent', 'POST /kyc/selfie']);
    expect(f.bodies('/kyc/consent')).toEqual([{ purpose: 'face-match' }]);
  });

  it('startEsign: esign and kra-upload as two separate consents (one screen, two ticks)', async () => {
    const f = fakeFetch({ 'POST /kyc/consent': [ok], 'POST /kyc/esign': [{ status: 200, body: { redirectUrl: 'https://p.test/e', kyc: view({ next: 'esign' }) } }] });
    await client(f).startEsign('https://app.test/r');
    expect(f.bodies('/kyc/consent')).toEqual([{ purpose: 'esign' }, { purpose: 'kra-upload' }]);
    expect(f.paths().at(-1)).toBe('POST /kyc/esign');
    expect(STEP_CONSENT.esign).toEqual(['esign', 'kra-upload']);
  });

  it('a failed consent call stops the step (no paid call)', async () => {
    const f = fakeFetch({ 'POST /kyc/consent': [{ status: 503, body: { error: 'internal' } }], 'POST /kyc/start': [{ status: 200, body: view() }] });
    await expect(client(f).startKyc(input)).rejects.toBeInstanceOf(ServerError);
    expect(f.paths()).toEqual(['POST /kyc/consent']);
  });

  it('409 consent-required (either spelling) is ServerError consent_required with a fixed text', async () => {
    const f = fakeFetch({
      'POST /kyc/consent': [ok],
      'POST /kyc/start': [{ status: 409, body: { error: 'consent-required', message: 'ABCPE1234F' } }, { status: 409, body: { error: 'consent_required' } }],
    });
    const c = client(f);
    for (let i = 0; i < 2; i++) {
      const e = await c.startKyc(input).catch((x) => x);
      expect(e).toMatchObject({ status: 409, code: 'consent_required', message: KYC_TEXT.consentNeeded });
      expect(isConsentRequired(e)).toBe(true);
    }
  });

  it('every purpose has a tick text', () => {
    for (const p of CONSENT_PURPOSES) expect(CONSENT_TEXT[p].length).toBeGreaterThan(10);
  });
});

describe('R3 retry after a partner timeout', () => {
  it('maps an under-review partner-timeout wait to next "retry"', () => {
    expect(toKycStatusView({ status: 'under-review', reason: 'partner-timeout', next: 'wait' }).next.type).toBe('retry');
    expect(toKycStatusView({ status: 'under-review', reason: 'partner-timeout', next: 'kra-lookup' }).next.type).toBe('retry');
    expect(toKycStatusView({ status: 'under-review', reason: 'check-unclear', next: 'wait' }).next.type).toBe('wait');
    // a step the server re-opened after a timeout stays that step
    expect(toKycStatusView({ status: 'under-review', reason: 'partner-timeout', next: 'aadhaar' }).next.type).toBe('digilocker');
    expect(toKycStatusView({ status: 'verified', reason: 'partner-timeout', next: 'wait' }).next.type).toBe('none');
  });

  it('retry() posts /kyc/retry with an Idempotency-Key and skips the consent call (consent on record)', async () => {
    const f = fakeFetch({ 'POST /kyc/retry': [{ status: 200, body: view({ status: 'pre-verified', reason: 'in-progress', next: 'aadhaar' }) }] });
    const v = await client(f).retry();
    expect(f.paths()).toEqual(['POST /kyc/retry']);
    expect(f.calls[0]!.init.headers['idempotency-key']).toMatch(/^k-/);
    expect(v.next.type).toBe('digilocker');
  });

  it('consent_required on retry -> retry(true) records pan-check first, then retries', async () => {
    const f = fakeFetch({
      'POST /kyc/consent': [ok],
      'POST /kyc/retry': [{ status: 409, body: { error: 'consent-required' } }, { status: 200, body: view({ status: 'under-review', reason: 'partner-timeout', next: 'wait' }) }],
    });
    const c = client(f);
    const e = await c.retry().catch((x) => x);
    expect(isConsentRequired(e)).toBe(true);
    expect(f.paths()).toEqual(['POST /kyc/retry']);
    await c.retry(true);
    expect(f.paths()).toEqual(['POST /kyc/retry', 'POST /kyc/consent', 'POST /kyc/retry']);
    expect(f.bodies('/kyc/consent')).toEqual([{ purpose: 'pan-check' }]);
  });

  it('retry() never calls consent, even when this session has none recorded', async () => {
    const f = fakeFetch({ 'POST /kyc/retry': [{ status: 200, body: view() }] });
    const c = client(f);
    expect(c.hasConsent('pan-check')).toBe(false);
    await c.retry();
    expect(f.paths()).toEqual(['POST /kyc/retry']);
  });

  it('redo opens the user step', async () => {
    const f = fakeFetch({ 'POST /kyc/retry': [
      { status: 200, body: { ...view({ next: 'wait' }), redo: 'aadhaar' } },
      { status: 200, body: { ...view({ next: 'wait' }), redo: 'selfie' } },
      { status: 200, body: { ...view({ next: 'wait' }), redo: 'esign' } },
      { status: 200, body: { ...view({ status: 'verified', next: 'none' }), redo: 'esign' } },
    ] });
    const c = client(f);
    expect((await c.retry()).next.type).toBe('digilocker');
    expect((await c.retry()).next.type).toBe('documents');
    expect((await c.retry()).next.type).toBe('esign');
    expect((await c.retry()).next.type).toBe('none');
  });

  it('retry limit reached keeps the fixed limit text', async () => {
    const f = fakeFetch({ 'POST /kyc/retry': [{ status: 429, body: { error: 'limit_reached' } }] });
    await expect(client(f).retry()).rejects.toMatchObject({ code: 'limit_reached' });
  });
});

describe('R1 all three documents', () => {
  const uploads = { status: 200, body: { uploads: [
    { kind: 'selfie', uploadId: 'selfie-1.jpg', url: 'https://s3.test/s', headers: { 'content-type': 'image/jpeg' } },
    { kind: 'aadhaar', uploadId: 'aadhaar-1.pdf', url: 'https://s3.test/a', headers: { 'content-type': 'application/pdf' } },
    { kind: 'pan', uploadId: 'pan-1.png', url: 'https://s3.test/p', headers: { 'content-type': 'image/png' } },
  ] } };
  const files = [
    { kind: 'selfie' as const, contentType: 'image/jpeg' as const, size: 10 },
    { kind: 'aadhaar' as const, contentType: 'application/pdf' as const, size: 20 },
    { kind: 'pan' as const, contentType: 'image/png' as const, size: 30 },
  ];

  it('uploadDocuments: one /kyc/documents call, a PUT per file, uploadIds by kind', async () => {
    const f = fakeFetch({ 'POST /kyc/documents': [uploads] });
    const c = client(f);
    const put: string[] = [];
    const ids = await c.uploadDocuments(files, async (u, kind) => { put.push(`${kind} ${u.url}`); return true; });
    expect(ids).toEqual({ selfie: 'selfie-1.jpg', aadhaar: 'aadhaar-1.pdf', pan: 'pan-1.png' });
    expect(f.bodies('/kyc/documents')).toEqual([{ files }]);
    expect(put).toEqual(['selfie https://s3.test/s', 'aadhaar https://s3.test/a', 'pan https://s3.test/p']);
    expect([...c.sentDocuments()].sort()).toEqual(['aadhaar', 'pan', 'selfie']);
  });

  it('a failed PUT throws upload_failed; the others still count as sent', async () => {
    const f = fakeFetch({ 'POST /kyc/documents': [uploads] });
    const c = client(f);
    const e = await c.uploadDocuments(files, async (_u, kind) => kind !== 'pan').catch((x) => x);
    expect(e).toMatchObject({ code: 'upload_failed', message: KYC_TEXT.uploadFailed });
    expect([...c.sentDocuments()].sort()).toEqual(['aadhaar', 'selfie']);
  });

  it('a throwing PUT counts as failed', async () => {
    const f = fakeFetch({ 'POST /kyc/documents': [uploads] });
    await expect(client(f).uploadDocuments(files, async () => { throw new Error('x'); })).rejects.toMatchObject({ code: 'upload_failed' });
  });

  const v = (status: KycStatusView['status'], next: KycStatusView['next']['type'], documents?: DocKind[]): KycStatusView =>
    ({ status, reason: null, next: { type: next }, ...(documents ? { documents } : {}) });

  it('kycDocsNeeded: selfie step asks the selfie plus the cards not held', () => {
    expect(kycDocsNeeded(v('pre-verified', 'documents'))).toEqual(['selfie', 'aadhaar', 'pan']);
    expect(kycDocsNeeded(v('pre-verified', 'documents'), new Set<DocKind>(['aadhaar', 'pan', 'selfie']))).toEqual(['selfie']);
    expect(kycDocsNeeded(v('pre-verified', 'documents', ['pan']))).toEqual(['selfie', 'aadhaar']);
  });

  it('kycDocsNeeded: hand-check / pan-in-use (under review) asks every kind not held', () => {
    expect(kycDocsNeeded(v('under-review', 'wait'))).toEqual(['selfie', 'aadhaar', 'pan']);
    expect(kycDocsNeeded(v('under-review', 'retry'), new Set<DocKind>(['selfie']))).toEqual(['aadhaar', 'pan']);
    expect(kycDocsNeeded(v('under-review', 'wait', ['selfie', 'aadhaar', 'pan']))).toEqual([]);
  });

  it('kycDocsNeeded: nothing before a case, on other steps or once decided', () => {
    expect(kycDocsNeeded(null)).toEqual([]);
    expect(kycDocsNeeded(v(null, 'start'))).toEqual([]);
    expect(kycDocsNeeded(v('pre-verified', 'digilocker'))).toEqual([]);
    expect(kycDocsNeeded(v('verified', 'none'))).toEqual([]);
    expect(kycDocsNeeded(v('rejected', 'none'))).toEqual([]);
  });

  it('status documents are parsed (known kinds only)', () => {
    expect(toKycStatusView({ status: 'under-review', next: 'wait', documents: ['pan', 'x', 'selfie'] }).documents).toEqual(['selfie', 'pan']);
    expect(toKycStatusView({ status: 'under-review', next: 'wait' }).documents).toBeUndefined();
  });
});

describe('withdraw consent and delete data', () => {
  it('withdrawConsent posts /kyc/consent/withdraw for every purpose', async () => {
    const f = fakeFetch({ 'POST /kyc/consent/withdraw': [ok] });
    const c = client(f);
    await c.withdrawConsent();
    expect(f.bodies('/kyc/consent/withdraw')).toEqual(CONSENT_PURPOSES.map((purpose) => ({ purpose })));
    expect(f.calls.every((x) => x.init.headers.authorization === 'Bearer A1')).toBe(true);
  });

  it('F11: errors after the first success are skipped and the rest are still sent', async () => {
    const f = fakeFetch({ 'POST /kyc/consent/withdraw': [ok, { status: 503, body: { error: 'internal' } }, { status: 404, body: { error: 'not_found' } }, ok] });
    const c = client(f);
    await c.giveConsent('digilocker').catch(() => undefined);
    await expect(c.withdrawConsent()).resolves.toBeUndefined();
    expect(f.bodies('/kyc/consent/withdraw')).toHaveLength(CONSENT_PURPOSES.length);
  });

  it('F11: a 404 on the first purpose is an error (no special 404 branch)', async () => {
    const f = fakeFetch({ 'POST /kyc/consent/withdraw': [{ status: 404, body: { error: 'not_found' } }] });
    await expect(client(f).withdrawConsent()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(f.calls).toHaveLength(1);
  });

  it('withdrawConsent forgets recorded consents, so the next step records again', async () => {
    const f = fakeFetch({ 'POST /kyc/consent': [ok], 'POST /kyc/consent/withdraw': [ok], 'POST /kyc/retry': [{ status: 200, body: view() }] });
    const c = client(f);
    await c.giveConsent('pan-check');
    await c.withdrawConsent(['pan-check']);
    expect(c.hasConsent('pan-check')).toBe(false);
    await c.retry(true);
    expect(f.paths()).toEqual(['POST /kyc/consent', 'POST /kyc/consent/withdraw', 'POST /kyc/consent', 'POST /kyc/retry']);
  });

  it('withdrawConsent stops on other errors', async () => {
    const f = fakeFetch({ 'POST /kyc/consent/withdraw': [{ status: 503, body: { error: 'internal' } }] });
    await expect(client(f).withdrawConsent()).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);
  });

  it('deleteKycData sends DELETE /kyc/data with the access token and no body', async () => {
    const f = fakeFetch({ 'DELETE /kyc/data': [ok] });
    await client(f).deleteKycData();
    expect(f.paths()).toEqual(['DELETE /kyc/data']);
    expect(f.calls[0]!.init.body).toBeUndefined();
    expect(f.calls[0]!.init.headers.authorization).toBe('Bearer A1');
    expect(f.calls[0]!.init.headers['x-wf-client']).toBe('web');
  });

  it('hasKycCase: only when the server has a case', () => {
    expect(hasKycCase(null)).toBe(false);
    expect(hasKycCase(toKycStatusView({ status: null, next: 'start' }))).toBe(false);
    expect(hasKycCase(toKycStatusView({ status: 'under-review', next: 'wait' }))).toBe(true);
  });

  it('after a withdraw the server may offer a new start', () => {
    expect(toKycStatusView({ status: 'under-review', reason: 'consent-withdrawn', next: 'start' }).next.type).toBe('start');
    expect(toKycStatusView({ status: 'under-review', reason: 'in-progress', next: 'start' }).next.type).toBe('wait');
  });

  it('staff-approved before e-sign: verified with next esign shows the e-sign step and is not eligible yet', async () => {
    const body = { status: 'verified', reason: 'staff-approved', next: 'esign', eligibleToInvest: false };
    const v = toKycStatusView(body);
    expect(v.next.type).toBe('esign');
    expect(serverEligibleToInvest(v)).toBe(false);
    expect(serverEligibleToInvest(toKycStatusView({ ...body, next: 'none', eligibleToInvest: true }))).toBe(true);
    const f = fakeFetch({ 'POST /kyc/consent': [ok], 'POST /kyc/esign': [{ status: 200, body: { redirectUrl: 'https://p.test/e', kyc: body } }] });
    await expect(client(f).startEsign('wealthfire://kyc-return')).resolves.toMatchObject({ next: { type: 'esign', url: 'https://p.test/e' } });
    expect(f.bodies('/kyc/esign')).toEqual([{ returnUrl: 'wealthfire://kyc-return' }]);
  });

  it('confirm texts', () => {
    expect(`${KYC_TEXT.withdrawTitle} ${KYC_TEXT.withdrawBody}`).toBe('Withdraw consent? We will stop your KYC. You can\u2019t invest until you finish KYC again.');
    expect(`${KYC_TEXT.deleteTitle} ${KYC_TEXT.deleteBody}`).toBe('Delete your KYC data? We delete your documents and details. Some records stay if the law needs them.');
  });

  it('feature id is registered', () => {
    expect(FEATURES.some((x) => x.id === 'kyc-data-controls')).toBe(true);
  });
});

describe('wave 4b', () => {
  const sv = (over: Partial<KycStatusView> & Pick<KycStatusView, 'status'>): KycStatusView => ({ reason: null, next: { type: 'wait' }, ...over });

  it('F5: upload_rejected and under_age have their own fixed texts', () => {
    expect(new ServerError(400, 'upload_rejected').message).toBe('This file doesn\'t look like a photo or PDF. Upload it again.');
    expect(new ServerError(400, 'under_age').message).toBe('You must be 18 or older to invest.');
  });

  it('F5: rejectedDocuments is parsed (known kinds only; empty list dropped)', () => {
    expect(toKycStatusView({ status: 'under-review', next: 'wait', rejectedDocuments: ['pan', 'x'] }).rejectedDocuments).toEqual(['pan']);
    expect(toKycStatusView({ status: 'under-review', next: 'wait', rejectedDocuments: [] }).rejectedDocuments).toBeUndefined();
    expect(toKycStatusView({ status: 'under-review', next: 'wait' }).rejectedDocuments).toBeUndefined();
  });

  it('F5: a refused kind is needed again and named in the upload-again line', () => {
    const v = sv({ status: 'under-review', reason: 'hand-check', documents: ['selfie', 'aadhaar'], rejectedDocuments: ['pan'] });
    expect(kycDocsNeeded(v)).toEqual(['pan']);
    expect(kycRejectedDocs(v)).toEqual(['pan']);
    expect(kycUploadAgainText(['pan'])).toBe('Upload your PAN card again. It doesn\'t look like a photo or PDF.');
    expect(kycUploadAgainText(['selfie', 'aadhaar', 'pan'])).toBe('Upload your selfie, Aadhaar card and PAN card again. They don\'t look like a photo or PDF.');
    expect(kycUploadAgainText([])).toBe('');
    // sent again in this session: no longer asked
    expect(kycDocsNeeded(v, new Set<DocKind>(['pan']))).toEqual([]);
    expect(kycRejectedDocs(v, new Set<DocKind>(['pan']))).toEqual([]);
    // the selfie step asks the refused card too
    expect(kycDocsNeeded(sv({ status: 'pre-verified', next: { type: 'documents' }, documents: ['aadhaar', 'pan'], rejectedDocuments: ['aadhaar'] }))).toEqual(['selfie', 'aadhaar']);
    expect(kycRejectedDocs(sv({ status: 'verified', rejectedDocuments: ['pan'] }))).toEqual([]);
  });

  it('F5: a status read reporting a refused kind takes it out of "sent"', async () => {
    const uploads = { status: 200, body: { uploads: [{ kind: 'pan', uploadId: 'pan-1.png', url: 'https://s3.test/p', headers: {} }] } };
    const f = fakeFetch({
      'POST /kyc/documents': [uploads],
      'GET /kyc/status': [{ status: 200, body: view({ status: 'under-review', reason: 'hand-check', next: 'wait', documents: [], rejectedDocuments: ['pan'] }) }],
    });
    const c = client(f);
    await c.uploadDocuments([{ kind: 'pan', contentType: 'image/png', size: 5 }], async () => true);
    expect(c.sentDocuments().has('pan')).toBe(true);
    const v = await c.getStatus();
    expect(c.sentDocuments().has('pan')).toBe(false);
    expect(kycDocsNeeded(v, c.sentDocuments())).toEqual(['selfie', 'aadhaar', 'pan']);
  });

  it('F5: a refused selfie (upload_rejected) is no longer counted as sent', async () => {
    const uploads = { status: 200, body: { uploads: [{ kind: 'selfie', uploadId: 'selfie-1.jpg', url: 'https://s3.test/s', headers: {} }] } };
    const f = fakeFetch({ 'POST /kyc/documents': [uploads], 'POST /kyc/consent': [ok], 'POST /kyc/selfie': [{ status: 400, body: { error: 'upload_rejected' } }] });
    const c = client(f);
    await c.uploadDocuments([{ kind: 'selfie', contentType: 'image/jpeg', size: 5 }], async () => true);
    const e = await c.submitSelfie('selfie-1.jpg').catch((x) => x);
    expect(e).toMatchObject({ code: 'upload_rejected', message: 'This file doesn\'t look like a photo or PDF. Upload it again.' });
    expect(c.sentDocuments().has('selfie')).toBe(false);
  });

  it('F7: approved with e-sign open shows "Approved – e-sign to finish", no reason; otherwise the status label', () => {
    const waiting = toKycStatusView({ status: 'verified', reason: 'staff-approved', next: 'esign', eligibleToInvest: false });
    expect(kycFinalLabel(waiting)).toBe('Approved \u2013 e-sign to finish');
    expect(kycFinalReason(waiting)).toBeUndefined();
    const done = toKycStatusView({ status: 'verified', reason: 'staff-approved', next: 'none', eligibleToInvest: true });
    expect(kycFinalLabel(done)).toBe('Verified');
    expect(kycFinalReason(done)).toBe('Approved by our team.');
    // eligibleToInvest not sent: no claim the e-sign is still open
    expect(kycFinalLabel(toKycStatusView({ status: 'verified', next: 'esign' }))).toBe('Verified');
    expect(kycFinalLabel(toKycStatusView({ status: 'under-review', next: 'wait' }))).toBe('Under review');
    expect(kycFinalReason(null)).toBeUndefined();
  });

  it('F8: the Demo reviewer never shows with a KYC server', () => {
    const kyc = { status: 'pre-verified' } as Parameters<typeof showDemoReviewer>[0]['kyc'];
    expect(showDemoReviewer({ dev: true, demoReader: true, serverConfigured: false, kyc })).toBe(true);
    expect(showDemoReviewer({ dev: true, demoReader: true, serverConfigured: true, kyc })).toBe(false);
    expect(showDemoReviewer({ dev: false, demoReader: true, serverConfigured: false, kyc })).toBe(false);
    expect(showDemoReviewer({ dev: true, demoReader: false, serverConfigured: false, kyc })).toBe(false);
    expect(showDemoReviewer({ dev: true, demoReader: true, serverConfigured: false, kyc: { ...kyc, status: 'verified' } })).toBe(false);
  });

  it('F10: an under-review partner timeout asks no documents (retry instead)', () => {
    const v = toKycStatusView({ status: 'under-review', reason: 'partner-timeout', next: 'wait' });
    expect(v.next.type).toBe('retry');
    expect(kycDocsNeeded(v)).toEqual([]);
    expect(kycDocsNeeded(toKycStatusView({ status: 'under-review', reason: 'hand-check', next: 'wait' }))).toEqual(['selfie', 'aadhaar', 'pan']);
  });

  it('F3: a verified case gets its own withdraw text and no stopped line; others keep the original', () => {
    const verified = sv({ status: 'verified', next: { type: 'none' } });
    expect(`${KYC_TEXT.withdrawTitle} ${kycWithdrawBody(verified)}`).toBe('Withdraw consent? Your KYC stays complete. We won\'t run new checks that need this consent.');
    expect(kycWithdrawDone(verified)).toBe('We recorded your withdrawal.');
    // approved, e-sign still open: still a verified case
    expect(kycWithdrawBody(sv({ status: 'verified', next: { type: 'esign' }, eligibleToInvest: false }))).toBe(KYC_TEXT.withdrawBodyVerified);
    for (const status of ['pre-verified', 'under-review'] as const) {
      expect(kycWithdrawBody(sv({ status }))).toBe(KYC_TEXT.withdrawBody);
      expect(kycWithdrawDone(sv({ status }))).toBe(KYC_TEXT.withdrawDone);
    }
    expect(kycWithdrawBody(null)).toBe(KYC_TEXT.withdrawBody);
  });
});

describe('web session: x-wf-client and the refresh cookie', () => {
  it('sends x-wf-client: web on every request (auth and kyc); cookie only on /auth', async () => {
    const f = fakeFetch({
      'POST /auth/otp/send': [{ status: 200, body: { challengeId: 'c'.repeat(22) } }],
      'POST /kyc/consent': [ok],
      'POST /kyc/start': [{ status: 200, body: view() }],
      'GET /kyc/status': [{ status: 200, body: view() }],
      'DELETE /kyc/data': [ok],
    });
    const c = client(f);
    await c.sendOtp('email', 'a@b.test');
    await c.startKyc(input);
    await c.getStatus();
    await c.deleteKycData();
    expect(f.calls.every((x) => x.init.headers['x-wf-client'] === 'web')).toBe(true);
    expect(f.calls.filter((x) => x.init.credentials === 'include').map((x) => x.url)).toEqual([`${BASE}/auth/otp/send`]);
  });

  it('a blocked cookie (refresh 400 / 401 / 403) ends the session: needsSignIn, no token kept', async () => {
    for (const status of [400, 401, 403]) {
      const t = memTokens(null);
      const f = fakeFetch({ 'POST /auth/refresh': [{ status, body: { error: status === 401 ? 'invalid_token' : 'bad_request' } }] });
      const e = await client(f, t).getStatus().catch((x) => x);
      expect(needsSignIn(e)).toBe(true);
      expect(e.message).toBe('Sign in to continue.');
      expect(t.access).toBeNull();
      expect(f.calls[0]!.init.body).toBe('{}'); // no refresh token from any store
    }
    expect(KYC_TEXT.signInAgain).toBe('Please sign in again.');
  });

  it('the app client does not treat refresh 400 as signed out', async () => {
    const f = fakeFetch({ 'POST /auth/refresh': [{ status: 400, body: { error: 'bad_request' } }] });
    const tokens = { ...memTokens(null), getRefresh: async () => 'R1', setRefresh: async () => {} };
    const e = await new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens, client: 'app' }).getStatus().catch((x) => x);
    expect(e).toMatchObject({ status: 400, code: 'bad_request' });
    expect(needsSignIn(e)).toBe(false);
  });

  it('web refresh 403 forbidden (cookie without the header / Origin) asks for sign-in; refreshToken in a body is ignored', async () => {
    const t = memTokens(null);
    const f = fakeFetch({ 'POST /auth/refresh': [{ status: 403, body: { error: 'forbidden' } }] });
    expect(needsSignIn(await client(f, t).getStatus().catch((x) => x))).toBe(true);
    expect(f.calls[0]!.init.credentials).toBe('include');
    expect(f.calls[0]!.init.headers['x-wf-client']).toBe('web');
    const stored: string[] = [];
    const t2 = { ...memTokens(null), getRefresh: async () => null, setRefresh: async (v: string | null) => { if (v) stored.push(v); } };
    const f2 = fakeFetch({
      'POST /auth/refresh': [{ status: 200, body: { accessToken: 'A9', refreshToken: 'LEAK' } }],
      'GET /kyc/status': [{ status: 200, body: view() }],
    });
    await new ServerKycClient({ baseUrl: BASE, fetch: f2.fetch, tokens: t2 }).getStatus();
    expect(stored).toEqual([]);
  });

  it('phones: no x-wf-client header, no cookie mode, refresh token in the body', async () => {
    const f = fakeFetch({ 'POST /auth/refresh': [{ status: 200, body: { accessToken: 'A2', refreshToken: 'R2' } }], 'GET /kyc/status': [{ status: 200, body: view() }] });
    const tokens = { ...memTokens(null), getRefresh: async () => 'R1', setRefresh: async () => {} };
    await new ServerKycClient({ baseUrl: BASE, fetch: f.fetch, tokens, client: 'app' }).getStatus();
    expect(f.calls.every((x) => x.init.headers['x-wf-client'] === undefined && x.init.credentials === undefined)).toBe(true);
    expect(JSON.parse(f.calls[0]!.init.body!)).toEqual({ refreshToken: 'R1' });
  });

  it('needsSignIn is false for other errors', () => {
    expect(needsSignIn(new ServerError(409, 'wrong_step'))).toBe(false);
    expect(needsSignIn(new ServerError(0, 'network'))).toBe(false);
    expect(needsSignIn(new Error('x'))).toBe(false);
  });
});
