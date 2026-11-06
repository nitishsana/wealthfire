// Pre-merge fixes: cross-tab reload rules (bug 1), hand-check fallback (bug 2), OCR load errors (bug 3).
import { describe, expect, it } from 'vitest';
import {
  DOC_MESSAGES, canSendForHandCheck, createOnDeviceReader, deserialize, emptyData, emptyKyc, emptyOnboarding,
  onboardingReducer, reviewReasonText, sanitizeOnboarding, serialize, type DocFile, type OnboardingState,
} from '../src';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 6, 6, 0, 0);
const file = (kind: DocFile['kind']): DocFile => ({ kind, name: `${kind}.jpg`, mime: 'image/jpeg', size: 200_000, uri: 'blob:x' });

function toDocuments(): OnboardingState {
  let s = onboardingReducer(emptyOnboarding(), { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
  s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0) });
  s = onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F' });
  return onboardingReducer(s, { type: 'aadhaar-verified', last4: '2346', at: iso(T0 + 5_000), provider: 'demo' });
}
const toCheck = () => onboardingReducer(toDocuments(), { type: 'documents-ready', at: iso(T0 + 6_000), reader: 'ondevice' });

describe('bug 1: reload option', () => {
  it('default (reload) moves check to documents and clears returnedFromCheck', () => {
    const s = { ...toCheck(), kyc: { ...toCheck().kyc, returnedFromCheck: true } };
    const out = sanitizeOnboarding(JSON.parse(JSON.stringify(s)));
    expect(out.step).toBe('documents');
    expect(out.kyc.returnedFromCheck).toBe(false);
    expect(sanitizeOnboarding(s, { reload: true }).step).toBe('documents');
  });
  it('reload false keeps check and returnedFromCheck', () => {
    expect(sanitizeOnboarding(toCheck(), { reload: false }).step).toBe('check');
    const back = onboardingReducer(toCheck(), { type: 'back-to-documents' });
    const out = sanitizeOnboarding(back, { reload: false });
    expect(out.step).toBe('documents');
    expect(out.kyc.returnedFromCheck).toBe(true);
  });
  it('reload false still runs safety rules', () => {
    // check without documentsAt, and a step past what the data supports
    const noDocs = { ...toCheck(), kyc: { ...toCheck().kyc, documentsAt: null } };
    expect(sanitizeOnboarding(noDocs, { reload: false }).step).toBe('documents');
    const skip = { ...toCheck(), step: 'done' };
    expect(sanitizeOnboarding(skip, { reload: false }).step).toBe('documents');
    const noAadhaar = { ...toCheck(), aadhaar: null };
    expect(sanitizeOnboarding(noAadhaar, { reload: false }).step).toBe('aadhaar-otp');
  });
  it('deserialize passes the option through; default is reload', () => {
    const json = serialize({ ...emptyData(), onboarding: toCheck() });
    expect(deserialize(json).onboarding.step).toBe('documents');
    expect(deserialize(json, { reload: false }).onboarding.step).toBe('check');
  });
});

describe('bug 2: hand-check fallback', () => {
  it('emptyKyc has zero failedReads; sanitize clamps 0-9', () => {
    expect(emptyKyc().failedReads).toEqual({ pan: 0, aadhaar: 0 });
    const s = { ...toDocuments(), kyc: { ...emptyKyc(), failedReads: { pan: 42, aadhaar: -3 } } };
    expect(sanitizeOnboarding(s).kyc.failedReads).toEqual({ pan: 9, aadhaar: 0 });
    const bad = { ...toDocuments(), kyc: { ...emptyKyc(), failedReads: 'x' } };
    expect(sanitizeOnboarding(bad).kyc.failedReads).toEqual({ pan: 0, aadhaar: 0 });
    expect(sanitizeOnboarding({ ...toDocuments(), kyc: { ...emptyKyc(), failedReads: { pan: 2.7 } } }).kyc.failedReads).toEqual({ pan: 2, aadhaar: 0 });
  });
  it('read-failed counts up from documents or check, caps at 9, ignored elsewhere', () => {
    let s = onboardingReducer(toDocuments(), { type: 'read-failed', field: 'pan' });
    expect(s.kyc.failedReads).toEqual({ pan: 1, aadhaar: 0 });
    expect(canSendForHandCheck(s.kyc)).toBe(false);
    s = onboardingReducer(s, { type: 'read-failed', field: 'pan' });
    expect(canSendForHandCheck(s.kyc)).toBe(true);
    for (let i = 0; i < 20; i++) s = onboardingReducer(s, { type: 'read-failed', field: 'pan' });
    expect(s.kyc.failedReads.pan).toBe(9);
    const c = onboardingReducer(toCheck(), { type: 'read-failed', field: 'aadhaar' });
    expect(c.kyc.failedReads.aadhaar).toBe(1);
    const early = emptyOnboarding();
    expect(onboardingReducer(early, { type: 'read-failed', field: 'pan' })).toBe(early);
  });
  it('read-failed unavailable sets 2 at once', () => {
    const s = onboardingReducer(toDocuments(), { type: 'read-failed', field: 'aadhaar', unavailable: true });
    expect(s.kyc.failedReads).toEqual({ pan: 0, aadhaar: 2 });
    expect(canSendForHandCheck(s.kyc)).toBe(true);
  });
  it('send-for-hand-check from check: under review with masked hand-check rows', () => {
    let s = toCheck();
    s = onboardingReducer(s, { type: 'read-failed', field: 'pan' });
    s = onboardingReducer(s, { type: 'read-failed', field: 'pan' });
    s = onboardingReducer(s, { type: 'read-failed', field: 'aadhaar' });
    const at = iso(T0 + 60_000);
    const d = onboardingReducer(s, { type: 'send-for-hand-check', at });
    expect(d.step).toBe('done');
    expect(d.completedAt).toBe(at);
    expect(d.kyc.match).toBe('review');
    expect(d.kyc.status).toBe('under-review');
    expect(d.kyc.review).toEqual({
      id: `rv_${(T0 + 60_000).toString(36)}`, sentAt: at, decision: null,
      fields: [
        { field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'unreadable', handCheck: true },
        { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'not read' },
      ],
    });
    // both cards
    const both = onboardingReducer(onboardingReducer(s, { type: 'read-failed', field: 'aadhaar' }), { type: 'send-for-hand-check', at });
    expect(both.kyc.review!.fields.map((f) => [f.field, f.typedMasked])).toEqual([['pan', 'ABCPS****F'], ['aadhaar', 'XXXX XXXX 2346']]);
    expect(serialize({ ...emptyData(), onboarding: both })).not.toMatch(/\d{12}/);
  });
  it('first-time user: two failed reads on documents, then send-for-hand-check -> done + under-review', () => {
    const at = iso(T0 + 60_000);
    let s = toDocuments();
    expect(s.kyc.documentsAt).toBeNull();
    expect(onboardingReducer(s, { type: 'send-for-hand-check', at })).toBe(s);
    s = onboardingReducer(s, { type: 'read-failed', field: 'aadhaar' });
    s = onboardingReducer(s, { type: 'read-failed', field: 'aadhaar' });
    const d = onboardingReducer(s, { type: 'send-for-hand-check', at });
    expect(d.step).toBe('done');
    expect(d.kyc.status).toBe('under-review');
    expect(d.kyc.match).toBe('review');
    expect(d.kyc.documentsAt).toBe(at);
    expect(d.kyc.review!.fields).toEqual([
      { field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'not read' },
      { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'unreadable', handCheck: true },
    ]);
  });
  it('send-for-hand-check needs failed reads and a valid time; keeps an earlier documentsAt', () => {
    const at = iso(T0 + 60_000);
    expect(onboardingReducer(toCheck(), { type: 'send-for-hand-check', at }).step).toBe('check');
    expect(onboardingReducer(onboardingReducer(toCheck(), { type: 'read-failed', field: 'pan', unavailable: true }), { type: 'send-for-hand-check', at }).kyc.documentsAt).toBe(iso(T0 + 6_000));
    // documents after Back: allowed
    let back = onboardingReducer(toCheck(), { type: 'back-to-documents' });
    back = onboardingReducer(back, { type: 'read-failed', field: 'pan', unavailable: true });
    expect(onboardingReducer(back, { type: 'send-for-hand-check', at }).step).toBe('done');
    expect(onboardingReducer(back, { type: 'send-for-hand-check', at: 'nope' }).step).toBe('documents');
    // documents-ready still works with failed reads recorded
    expect(onboardingReducer(back, { type: 'documents-ready', at, reader: 'ondevice' }).step).toBe('check');
  });
  it('hand-check review survives a reload and shows its reason', () => {
    const s = onboardingReducer(onboardingReducer(toCheck(), { type: 'read-failed', field: 'pan', unavailable: true }), { type: 'send-for-hand-check', at: iso(T0 + 60_000) });
    const out = deserialize(serialize({ ...emptyData(), onboarding: s })).onboarding;
    expect(out.step).toBe('done');
    expect(out.kyc.status).toBe('under-review');
    expect(out.kyc.review!.fields).toEqual(s.kyc.review!.fields);
    expect(reviewReasonText(out.kyc.review!.fields[0]!)).toBe("Couldn't be read");
    // 'unreadable' is only accepted on a hand-check row
    const forged = { ...s, kyc: { ...s.kyc, review: { ...s.kyc.review!, fields: [{ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'unreadable' }] } } };
    expect(sanitizeOnboarding(forged).kyc.review!.fields).toEqual([]);
  });
  it('a successful check-confirmed resets failedReads', () => {
    const s = onboardingReducer(toCheck(), { type: 'read-failed', field: 'pan' });
    const d = onboardingReducer(s, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at: iso(T0 + 60_000) });
    expect(d.step).toBe('done');
    expect(d.kyc.failedReads).toEqual({ pan: 0, aadhaar: 0 });
  });
  it('messages', () => {
    expect(DOC_MESSAGES.handCheckButton).toBe('Send my documents for a hand check');
    expect(DOC_MESSAGES.handCheckNote).toBe("We couldn't read your card. Our team can check your documents by hand instead.");
  });
});

describe('bug 3: OCR load errors', () => {
  const failWith = (code?: string) => createOnDeviceReader(async () => {
    const e = new Error('x') as Error & { code?: string };
    if (code) e.code = code;
    throw e;
  });
  it('ocr-load and network codes map to network / couldNotReadDocs', async () => {
    for (const code of ['ocr-load', 'network']) {
      expect(await failWith(code).read(file('pan'), 'pan', { strict: false })).toEqual({ ok: false, reason: 'network', message: DOC_MESSAGES.couldNotReadDocs });
    }
  });
  it('other errors stay unreadable; PDF codes unchanged', async () => {
    expect(await failWith().read(file('aadhaar'), 'aadhaar', { strict: false })).toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.unreadable('aadhaar') });
    expect(await failWith('boom').read(file('pan'), 'pan', { strict: false })).toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.unreadable('pan') });
    expect(await failWith('pdf-locked').read(file('pan'), 'pan', { strict: false })).toEqual({ ok: false, reason: 'locked', message: DOC_MESSAGES.pdfLocked });
  });
});
