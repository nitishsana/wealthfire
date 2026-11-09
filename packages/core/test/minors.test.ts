// Onboarding minor issues: hand-check review lists both cards (issue 6), every failed read counts
// toward the hand check (issue 6), never-throwing reader / OTP factories (issue 1).
import { describe, expect, it } from 'vitest';
import {
  DOC_MESSAGES, DemoOtpProvider, NOT_READ_MASK, countsAsFailedRead, createDocumentReader, createDocumentReaderSafe,
  createOnDeviceReader, createOtpProvider, createOtpProviderSafe, deserialize, emptyData, emptyOnboarding,
  onboardingReducer, reviewReasonText, reviewRowReasonText, sanitizeOnboarding, serialize, type DocFile, type OnboardingState,
  type ReadResult,
} from '../src';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 6, 6, 0, 0);
const AT = iso(T0 + 60_000);
const file = (kind: DocFile['kind']): DocFile => ({ kind, name: `${kind}.jpg`, mime: 'image/jpeg', size: 200_000, uri: 'blob:x' });

function toCheck(): OnboardingState {
  let s = onboardingReducer(emptyOnboarding(), { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
  s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0) });
  s = onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' });
  s = onboardingReducer(s, { type: 'aadhaar-verified', last4: '2346', at: iso(T0 + 5_000), provider: 'demo' });
  return onboardingReducer(s, { type: 'documents-ready', at: iso(T0 + 6_000), reader: 'ondevice' });
}
const failTwice = (s: OnboardingState, field: 'pan' | 'aadhaar') =>
  onboardingReducer(onboardingReducer(s, { type: 'read-failed', field }), { type: 'read-failed', field });

describe('issue 6: hand-check review lists both cards', () => {
  it('failed PAN + read Aadhaar: Aadhaar row has the mask of its last read', () => {
    const d = onboardingReducer(failTwice(toCheck(), 'pan'), {
      type: 'send-for-hand-check', at: AT, reads: { aadhaar: '4991 1866 5246', pan: 'AAAPZ9999Z' },
    });
    expect(d.kyc.review!.fields).toEqual([
      { field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'unreadable', handCheck: true },
      { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 5246' },
    ]);
    // only masks are stored: never the full read Aadhaar
    const json = serialize({ ...emptyData(), onboarding: d });
    expect(json).not.toMatch(/\d{12}/);
    expect(json).not.toContain('499118665246');
    expect(json).not.toContain('AAAPZ9999Z');
  });
  it('failed Aadhaar + read PAN: PAN row masked', () => {
    const d = onboardingReducer(failTwice(toCheck(), 'aadhaar'), { type: 'send-for-hand-check', at: AT, reads: { pan: 'abcps1234f' } });
    expect(d.kyc.review!.fields).toEqual([
      { field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'ABCPS****F' },
      { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'unreadable', handCheck: true },
    ]);
  });
  it("no read for the other card, or a junk value: 'not read'", () => {
    const s = failTwice(toCheck(), 'pan');
    for (const reads of [undefined, {}, { aadhaar: '12' }, { aadhaar: 'x'.repeat(12) }]) {
      const d = onboardingReducer(s, { type: 'send-for-hand-check', at: AT, ...(reads ? { reads } : {}) });
      expect(d.kyc.review!.fields[1]).toEqual({ field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: NOT_READ_MASK });
    }
    expect(NOT_READ_MASK).toBe('not read');
  });
  it('both cards failed: both unreadable, reads ignored', () => {
    const d = onboardingReducer(failTwice(failTwice(toCheck(), 'pan'), 'aadhaar'), {
      type: 'send-for-hand-check', at: AT, reads: { pan: 'ABCPS1234F', aadhaar: '234123412346' },
    });
    expect(d.kyc.review!.fields.map((f) => [f.field, f.readMasked, f.handCheck])).toEqual([
      ['pan', 'unreadable', true], ['aadhaar', 'unreadable', true],
    ]);
  });
  it("both rows survive a reload; 'not read' only stays on a non-hand-check row", () => {
    const d = onboardingReducer(failTwice(toCheck(), 'pan'), { type: 'send-for-hand-check', at: AT });
    const out = deserialize(serialize({ ...emptyData(), onboarding: d })).onboarding;
    expect(out.kyc.review!.fields).toEqual(d.kyc.review!.fields);
    const forged = { ...d, kyc: { ...d.kyc, review: { ...d.kyc.review!, fields: [{ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'not read', handCheck: true }] } } };
    expect(sanitizeOnboarding(forged).kyc.review!.fields).toEqual([]);
  });
  it("'not read' is not accepted in a check-confirmed review", () => {
    const s = toCheck();
    const e = { type: 'check-confirmed' as const, match: 'review' as const, pan: 'ABCPS1234F', at: AT,
      fields: [{ field: 'pan' as const, typedMasked: 'ABCPS****F', readMasked: 'not read' }] };
    expect(onboardingReducer(s, e)).toBe(s);
  });
  it('reason texts for the rows', () => {
    const d = onboardingReducer(failTwice(toCheck(), 'pan'), { type: 'send-for-hand-check', at: AT, reads: { aadhaar: '499118665246' } });
    const [pan, aadhaar] = d.kyc.review!.fields;
    expect(reviewReasonText(pan!)).toBe("Couldn't be read");
    expect(reviewRowReasonText(aadhaar!, d.kyc.review!.fields)).toBe('Sent with the hand check');
    expect(reviewRowReasonText(pan!, d.kyc.review!.fields)).toBe("Couldn't be read");
    const notRead = onboardingReducer(failTwice(toCheck(), 'pan'), { type: 'send-for-hand-check', at: AT }).kyc.review!.fields;
    expect(reviewRowReasonText(notRead[1]!, notRead)).toBe('Not read');
    // a normal review row is unchanged
    const row = { field: 'pan' as const, typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z' };
    expect(reviewRowReasonText(row, [row])).toBe("Number doesn't match");
    expect(reviewReasonText({ field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'not read' })).toBe('Not read');
    // unchanged without the list
    expect(reviewReasonText({ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z' })).toBe("Number doesn't match");
  });
});

describe('issue 6: every failed read counts toward the hand check', () => {
  it('countsAsFailedRead is !ok for every reason', () => {
    const fails: ReadResult[] = (['unreadable', 'invalid', 'network', 'locked'] as const).map((reason) => ({ ok: false, reason, message: 'x' }));
    for (const r of fails) expect(countsAsFailedRead(r)).toBe(true);
    expect(countsAsFailedRead({ ok: true, value: 'ABCPS1234F', nameMatch: true })).toBe(false);
    expect(countsAsFailedRead({ ok: true, value: 'ABCPS1234F', nameMatch: null })).toBe(false);
  });
  it('a company-PAN read counts', async () => {
    const text = ['INCOME TAX DEPARTMENT', 'GOVT. OF INDIA', 'Permanent Account Number Card', 'ABCCE1234F', 'Name', 'NITISH SANA'].join('\n');
    const reader = createOnDeviceReader(async () => [text]);
    const r = await reader.read(file('pan'), 'pan', { strict: false });
    expect(r).toEqual({ ok: false, reason: 'invalid', message: DOC_MESSAGES.companyPan });
    expect(countsAsFailedRead(r)).toBe(true);
  });
});

describe('issue 1: never-throwing factories', () => {
  const extract = async () => ['x'];
  it('createDocumentReaderSafe: known ids as before, unknown → on-device', async () => {
    expect(() => createDocumentReader({ reader: 'digio' })).toThrow();
    const r = createDocumentReaderSafe({ reader: 'digio', extract });
    expect(r.id).toBe('ondevice');
    expect(r.isDemo).toBe(false);
    expect(createDocumentReaderSafe({ reader: 'demo' }).isDemo).toBe(true);
    expect(createDocumentReaderSafe({ extract }).id).toBe('ondevice');
    // unknown id and no extract: on-device reader that reports unavailable
    const none = createDocumentReaderSafe({ reader: 'nope' });
    expect(none.id).toBe('ondevice');
    expect(await none.read(file('pan'), 'pan', { strict: false })).toEqual({ ok: false, reason: 'unreadable', message: DOC_MESSAGES.readerUnavailable });
  });
  it('createOtpProviderSafe: unknown → demo provider', () => {
    expect(() => createOtpProvider({ provider: 'digilocker' })).toThrow();
    for (const provider of ['digilocker', undefined, '', 'demo']) {
      const p = createOtpProviderSafe(provider === undefined ? {} : { provider });
      expect(p).toBeInstanceOf(DemoOtpProvider);
      expect(p.id).toBe('demo');
    }
  });
});
