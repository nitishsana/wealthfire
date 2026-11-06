import { describe, expect, it } from 'vitest';
import {
  MAX_REREADS, applyReread, canReread, checkOutcome, compareField, emptyData, emptyOnboarding, initialChecks,
  isEligibleToInvest, kycStatusLabel, reviewFields, takeDocumentNumber,
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
  it('names true or null (not checked) with matching numbers → matched', () => {
    expect(checkOutcome(initialChecks(typed, typed, { pan: true, aadhaar: true })).match).toBe('matched');
    expect(checkOutcome(initialChecks(typed, typed, { pan: null, aadhaar: true })).match).toBe('matched');
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
  const withKyc = (step: 'done' | 'aadhaar-otp', status: 'verified' | 'under-review' | 'rejected' | null) => ({
    ...emptyData(),
    onboarding: { ...emptyOnboarding(), step, kyc: { ...emptyOnboarding().kyc, match: 'matched' as const, status } },
  });
  it('true only for done + verified', () => {
    expect(isEligibleToInvest(withKyc('done', 'verified'))).toBe(true);
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
  });
});
