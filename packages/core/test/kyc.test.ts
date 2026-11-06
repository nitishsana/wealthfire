import { describe, expect, it } from 'vitest';
import {
  MAX_REREADS, applyReread, canReread, checkOutcome, compareField, emptyData, emptyOnboarding, initialChecks,
  isEligibleToInvest, kycStatusLabel, reviewFields, reviewReasonText, takeDocumentNumber, canFinalApprove,
  type KycStatus,
} from '../src';

const PAN = 'ABCPS1234F';
const AADHAAR = '234123412346';
const OTHER_AADHAAR = '499118665246';

describe('compareField', () => {
  it('normalizes before comparing', () => {
    expect(compareField('pan', ' abcps1234f', PAN)).toBe(true);
    expect(compareField('aadhaar', '2341 2341 2346', AADHAAR)).toBe(true);
    expect(compareField('aadhaar', AADHAAR, OTHER_AADHAAR)).toBe(false);
    expect(compareField('pan', '', '')).toBe(false);
  });
});

describe('check logic', () => {
  it('match → matched', () => {
    const cs = initialChecks({ pan: PAN, aadhaar: '2341 2341 2346' }, { pan: PAN, aadhaar: AADHAAR });
    expect(cs.map((c) => c.field)).toEqual(['pan', 'aadhaar']);
    expect(cs.every((c) => c.matched && c.source === 'typed' && c.rereads === 0)).toBe(true);
    expect(cs[1]!.final).toBe(AADHAAR);
    expect(checkOutcome(cs)).toEqual({ match: 'matched', differs: [] });
    expect(reviewFields(cs)).toEqual([]);
  });

  it('mismatch + use document → matched', () => {
    const names = { pan: true, aadhaar: true };
    const [pan, aad] = initialChecks({ pan: PAN, aadhaar: AADHAAR }, { pan: 'ABCPS1235F', aadhaar: AADHAAR }, names);
    expect(pan!.matched).toBe(false);
    expect(checkOutcome([pan!, aad!])).toEqual({ match: 'review', differs: ['pan'] });
    const used = takeDocumentNumber(pan!);
    expect(used).toMatchObject({ final: 'ABCPS1235F', matched: true, source: 'document', nameMatch: true });
    expect(checkOutcome([used, aad!]).match).toBe('matched');
  });

  it('mismatch + edit + strict re-read equal → matched', () => {
    const [pan, aad] = initialChecks({ pan: PAN, aadhaar: AADHAAR }, { pan: PAN, aadhaar: OTHER_AADHAAR });
    const fixed = applyReread(aad!, '4991 1866 5246', OTHER_AADHAAR);
    expect(fixed).toMatchObject({ final: OTHER_AADHAAR, matched: true, rereads: 1, source: 'edited' });
    expect(checkOutcome([pan!, fixed]).match).toBe('matched');
    // upload again (same typed number) and the strict read now agrees
    const again = applyReread(aad!, AADHAAR, AADHAAR);
    expect(again).toMatchObject({ matched: true, rereads: 1, source: 'typed' });
  });

  it('still differs after re-read → review, with masks only', () => {
    const [pan, aad] = initialChecks({ pan: PAN, aadhaar: AADHAAR }, { pan: PAN, aadhaar: OTHER_AADHAAR });
    const still = applyReread(aad!, AADHAAR, OTHER_AADHAAR);
    expect(still.matched).toBe(false);
    expect(checkOutcome([pan!, still])).toEqual({ match: 'review', differs: ['aadhaar'] });
    const fields = reviewFields([pan!, still]);
    expect(fields).toEqual([{ field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 5246' }]);
    expect(JSON.stringify(fields)).not.toMatch(/\d{5,}/);
    const [p2] = initialChecks({ pan: PAN, aadhaar: AADHAAR }, { pan: 'AAAPZ9999Z', aadhaar: AADHAAR });
    expect(reviewFields([p2!])).toEqual([{ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z' }]);
  });

  it('third re-read is blocked', () => {
    const [, aad] = initialChecks({ pan: PAN, aadhaar: AADHAAR }, { pan: PAN, aadhaar: OTHER_AADHAAR });
    expect(MAX_REREADS).toBe(2);
    const one = applyReread(aad!, AADHAAR, OTHER_AADHAAR);
    const two = applyReread(one, AADHAAR, OTHER_AADHAAR);
    expect(canReread(one)).toBe(true);
    expect(canReread(two)).toBe(false);
    expect(applyReread(two, AADHAAR, AADHAAR)).toBe(two);
    expect(two.rereads).toBe(2);
  });
});

describe('name check', () => {
  const typed = { pan: PAN, aadhaar: AADHAAR };
  it('initialChecks defaults nameMatch to null and takes it from the reads', () => {
    expect(initialChecks(typed, typed).map((c) => c.nameMatch)).toEqual([null, null]);
    expect(initialChecks(typed, typed, { pan: true, aadhaar: false }).map((c) => c.nameMatch)).toEqual([true, false]);
  });
  it('numbers match but a name failed → review, with nameMismatch on that field', () => {
    const cs = initialChecks(typed, typed, { pan: true, aadhaar: false });
    expect(checkOutcome(cs)).toEqual({ match: 'review', differs: ['aadhaar'] });
    expect(reviewFields(cs)).toEqual([
      { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 2346', nameMismatch: true },
    ]);
  });
  it('names true with matching numbers → matched; a read name left null (not checked) → review', () => {
    expect(checkOutcome(initialChecks(typed, typed, { pan: true, aadhaar: true })).match).toBe('matched');
    expect(checkOutcome(initialChecks(typed, typed, { pan: null, aadhaar: true })).match).toBe('review');
    expect(reviewFields(initialChecks(typed, typed, { pan: true, aadhaar: true }))).toEqual([]);
  });
  it('number and name both wrong → one review entry with both', () => {
    const [pan] = initialChecks(typed, { pan: 'AAAPZ9999Z', aadhaar: AADHAAR }, { pan: false, aadhaar: true });
    expect(reviewFields([pan!])).toEqual([{ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z', nameMismatch: true }]);
  });
  it('takeDocumentNumber counts as matched only when nameMatch === true', () => {
    const read = { pan: 'AAAPZ9999Z', aadhaar: AADHAAR };
    for (const nm of [false, null] as const) {
      const [pan, aad] = initialChecks(typed, read, { pan: nm, aadhaar: true });
      const used = takeDocumentNumber(pan!);
      expect(used).toMatchObject({ final: 'AAAPZ9999Z', matched: false, source: 'document' });
      expect(checkOutcome([used, aad!])).toEqual({ match: 'review', differs: ['pan'] });
    }
    const [pan, aad] = initialChecks(typed, read, { pan: true, aadhaar: true });
    expect(checkOutcome([takeDocumentNumber(pan!), aad!])).toEqual({ match: 'matched', differs: [] });
  });
  it('applyReread keeps the name result unless a new one is given', () => {
    const [, aad] = initialChecks(typed, { pan: PAN, aadhaar: OTHER_AADHAAR }, { pan: true, aadhaar: false });
    expect(applyReread(aad!, AADHAAR, AADHAAR).nameMatch).toBe(false);
    const fixed = applyReread(aad!, AADHAAR, AADHAAR, true);
    expect(fixed.nameMatch).toBe(true);
    expect(checkOutcome([fixed]).match).toBe('matched');
  });
});

describe('eligibility and labels', () => {
  const withKyc = (step: 'done' | 'aadhaar-otp', status: KycStatus | null) => ({
    ...emptyData(),
    onboarding: { ...emptyOnboarding(), step, kyc: { ...emptyOnboarding().kyc, match: 'matched' as const, status } },
  });
  it('true only for done + verified', () => {
    expect(isEligibleToInvest(withKyc('done', 'verified'))).toBe(true);
    expect(isEligibleToInvest(withKyc('done', 'pre-verified'))).toBe(false);
    expect(isEligibleToInvest(withKyc('done', 'under-review'))).toBe(false);
    expect(isEligibleToInvest(withKyc('done', 'rejected'))).toBe(false);
    expect(isEligibleToInvest(withKyc('done', null))).toBe(false);
    expect(isEligibleToInvest(withKyc('aadhaar-otp', 'verified'))).toBe(false);
    expect(isEligibleToInvest(emptyData())).toBe(false);
  });
  it('status labels', () => {
    expect(kycStatusLabel('verified')).toBe('Verified');
    expect(kycStatusLabel('under-review')).toBe('Under review');
    expect(kycStatusLabel('rejected')).toBe('Review rejected');
    expect(kycStatusLabel(null)).toBe('Not started');
    expect(kycStatusLabel('pre-verified')).toBe('Pre-verified — final KYC pending');
  });
  it('canFinalApprove: under review or pre-verified only', () => {
    const k = (status: KycStatus | null) => ({ ...emptyOnboarding().kyc, status });
    expect(canFinalApprove(k('under-review'))).toBe(true);
    expect(canFinalApprove(k('pre-verified'))).toBe(true);
    expect(canFinalApprove(k('verified'))).toBe(false);
    expect(canFinalApprove(k('rejected'))).toBe(false);
    expect(canFinalApprove(k(null))).toBe(false);
  });
});

describe('name not checked (nameMatch null)', () => {
  const typed = { pan: PAN, aadhaar: AADHAAR };
  it('null after a read that was given a name needs review (same as false)', () => {
    const cs = initialChecks(typed, typed, { pan: null, aadhaar: null });
    expect(cs.every((c) => c.nameRequired === true && c.nameMatch === null)).toBe(true);
    expect(checkOutcome(cs)).toEqual({ match: 'review', differs: ['pan', 'aadhaar'] });
    expect(reviewFields(cs)).toEqual([
      { field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'ABCPS****F', nameNotChecked: true },
      { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 2346', nameNotChecked: true },
    ]);
    // one card checked, one not → only the unchecked one needs review
    expect(checkOutcome(initialChecks(typed, typed, { pan: true, aadhaar: null }))).toEqual({ match: 'review', differs: ['aadhaar'] });
    // a re-read that now matches clears it; one that still returns null keeps it in review
    const [pan] = cs;
    expect(checkOutcome([applyReread(pan!, PAN, PAN, true)])).toEqual({ match: 'matched', differs: [] });
    expect(checkOutcome([applyReread(pan!, PAN, PAN, null)])).toEqual({ match: 'review', differs: ['pan'] });
  });
  it('no name check at all (initialChecks without nameMatch) still matches on numbers', () => {
    const cs = initialChecks(typed, typed);
    expect(cs.some((c) => 'nameRequired' in c)).toBe(false);
    expect(checkOutcome(cs)).toEqual({ match: 'matched', differs: [] });
  });
  it('takeDocumentNumber still needs nameMatch === true', () => {
    const [pan] = initialChecks({ pan: 'ABCPS1235F', aadhaar: AADHAAR }, typed, { pan: null, aadhaar: null });
    const used = takeDocumentNumber(pan!);
    expect(used).toMatchObject({ final: PAN, matched: false, source: 'document', nameMatch: null });
    expect(checkOutcome([used])).toEqual({ match: 'review', differs: ['pan'] });
  });
});

describe('reviewReasonText', () => {
  it('names the reason for each review row', () => {
    expect(reviewReasonText({ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z' })).toBe("Number doesn't match");
    expect(reviewReasonText({ field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 2346', nameMismatch: true }))
      .toBe("Name doesn't match");
    expect(reviewReasonText({ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z', nameMismatch: true }))
      .toBe("Number and name don't match");
    expect(reviewReasonText({ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'ABCPS****F', nameNotChecked: true }))
      .toBe('Name not checked');
    expect(reviewReasonText({ field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z', nameNotChecked: true }))
      .toBe("Number doesn't match, name not checked");
  });

  it('Devanagari parent + child PAN → review (end to end)', async () => {
    const { createOnDeviceReader } = await import('../src');
    const childPan = 'INCOME TAX DEPARTMENT\nName\nRAHUL SANA\nFather\'s Name\nNITISH SANA\nDate of Birth 01/01/2015\nABCPS1234F';
    const r = createOnDeviceReader(async () => [childPan]);
    const file = { kind: 'pan' as const, name: 'p.jpg', mime: 'image/jpeg' as const, size: 1000, uri: 'blob:x' };
    for (const name of [{ first: 'नितीश', last: 'साना' }, { first: 'Nitish', last: 'साना' }]) {
      const read = await r.read(file, 'pan', { strict: false, name });
      expect(read).toEqual({ ok: true, value: PAN, nameMatch: null });
      const nm = read.ok ? read.nameMatch : null;
      const cs = initialChecks({ pan: PAN, aadhaar: AADHAAR }, { pan: PAN, aadhaar: AADHAAR }, { pan: nm, aadhaar: true });
      expect(checkOutcome(cs)).toEqual({ match: 'review', differs: ['pan'] });
      expect(takeDocumentNumber(cs[0]!).matched).toBe(false);
    }
  });
  it('works on the rows reviewFields makes', () => {
    const cs = initialChecks({ pan: 'AAAPZ9999Z', aadhaar: AADHAAR }, { pan: PAN, aadhaar: AADHAAR }, { pan: true, aadhaar: false });
    expect(reviewFields(cs).map(reviewReasonText)).toEqual(["Number doesn't match", "Name doesn't match"]);
  });
});
