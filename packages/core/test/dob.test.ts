import { describe, expect, it } from 'vitest';
import {
  DOB_HINT, DOB_LABEL, ageOn, deserialize, emptyData, emptyOnboarding, needsDob, normalizeDob, onboardingReducer, validateDob,
  type OnboardingState,
} from '../src';

// local calendar date 2026-11-09
const TODAY = new Date(2026, 10, 9, 12, 0, 0);
const FORMAT = 'Enter your date of birth as DD/MM/YYYY.';
const MINOR = 'You must be 18 or older to invest.';
const UNREAL = 'Enter a real date of birth.';

describe('date of birth', () => {
  it('labels', () => {
    expect([DOB_LABEL, DOB_HINT]).toEqual(['Date of birth', 'DD/MM/YYYY']);
  });

  it('normalizeDob accepts dd/mm/yyyy and yyyy-mm-dd, returns ISO', () => {
    expect(normalizeDob('15/01/1990')).toBe('1990-01-15');
    expect(normalizeDob(' 1990-01-15 ')).toBe('1990-01-15');
    expect(normalizeDob('31/02/1990')).toBe('');
    expect(normalizeDob('1/1/1990')).toBe('');
  });

  it('format errors', () => {
    for (const v of ['', '15-01-1990', '1/1/1990', '15/01/90', '1990/01/15', 'Jan 15 1990', '15/01/1990x']) {
      expect(validateDob(v, TODAY)).toBe(FORMAT);
    }
  });

  it('real-date errors: not a calendar date, future, over 120', () => {
    expect(validateDob('31/02/1990', TODAY)).toBe(UNREAL);
    expect(validateDob('00/01/1990', TODAY)).toBe(UNREAL);
    expect(validateDob('10/11/2026', TODAY)).toBe(UNREAL);
    expect(validateDob('2030-01-01', TODAY)).toBe(UNREAL);
    expect(validateDob('08/11/1905', TODAY)).toBe(UNREAL); // 121
    expect(validateDob('09/11/1906', TODAY)).toBeNull(); // exactly 120
  });

  it('18+ boundary', () => {
    expect(validateDob('09/11/2008', TODAY)).toBeNull(); // 18 today
    expect(validateDob('10/11/2008', TODAY)).toBe(MINOR); // 18 tomorrow
    expect(validateDob('2026-11-09', TODAY)).toBe(MINOR); // born today
    expect(validateDob('15/01/1990', TODAY)).toBeNull();
  });

  it('29 Feb birthday counts from 1 Mar in a non-leap year', () => {
    expect(ageOn('2008-02-29', new Date(2026, 1, 28))).toBe(17);
    expect(ageOn('2008-02-29', new Date(2026, 2, 1))).toBe(18);
  });

  it('identity-saved needs a valid 18+ dob and stores it as ISO', () => {
    const at = '2026-11-09T06:00:00.000Z';
    const s: OnboardingState = { ...emptyOnboarding(), step: 'identity' };
    const base = { type: 'identity-saved' as const, firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', at };
    for (const dob of ['', '31/02/1990', '01/01/2010', '2030-01-01']) {
      expect(onboardingReducer(s, { ...base, dob })).toBe(s);
    }
    const ok = onboardingReducer(s, { ...base, dob: '15/01/1990' });
    expect(ok.step).toBe('aadhaar-otp');
    expect(ok.identity).toEqual({ firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' });
    // 18+ is judged on the event time
    expect(onboardingReducer(s, { ...base, dob: '10/11/2008' })).toBe(s);
    expect(onboardingReducer(s, { ...base, dob: '10/11/2008', at: '2026-11-10T06:00:00.000Z' }).step).toBe('aadhaar-otp');
  });
});

describe('date of birth for users who onboarded before it was asked', () => {
  const doneUser = (identity: Record<string, unknown>) => {
    let s: OnboardingState = { ...emptyOnboarding(), step: 'identity', contact: { kind: 'mobile', value: '9876543210', verifiedAt: '2026-01-01T00:00:00.000Z' } };
    s = onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '15/01/1990', at: '2026-11-09T06:00:00.000Z' });
    s = { ...s, step: 'done', aadhaar: { last4: '2346', verifiedAt: '2026-01-01T00:00:00.000Z', provider: 'demo' },
      kyc: { ...s.kyc, match: 'matched', status: 'pre-verified' } };
    return deserialize(JSON.stringify({ ...emptyData(), onboarding: { ...s, identity } })).onboarding!;
  };
  const base = { firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F' };

  it('a stored done user without dob stays done with the identity kept', () => {
    const s = doneUser(base);
    expect(s.step).toBe('done');
    expect(s.identity).toEqual(base);
    expect(needsDob(s)).toBe(true);
  });

  it('an invalid or under-18 stored dob is dropped, identity and step kept', () => {
    for (const dob of ['31/02/1990', 'Jan 1990', `${new Date().getFullYear() - 5}-01-01`, 19900115]) {
      const s = doneUser({ ...base, dob });
      expect(s.step).toBe('done');
      expect(s.identity).toEqual(base);
      expect(needsDob(s)).toBe(true);
    }
    const ok = doneUser({ ...base, dob: '15/01/1990' });
    expect(ok.identity?.dob).toBe('1990-01-15');
    expect(needsDob(ok)).toBe(false);
  });

  it('dob-added stores ISO from any step with an identity; invalid is ignored', () => {
    const s = doneUser(base);
    const at = '2026-11-09T06:00:00.000Z';
    expect(onboardingReducer(s, { type: 'dob-added', dob: '01/01/2010', at })).toBe(s);
    expect(onboardingReducer(s, { type: 'dob-added', dob: 'nope', at })).toBe(s);
    const added = onboardingReducer(s, { type: 'dob-added', dob: '15/01/1990', at });
    expect(added.step).toBe('done');
    expect(added.identity).toEqual({ ...base, dob: '1990-01-15' });
    expect(needsDob(added)).toBe(false);
    const none = emptyOnboarding();
    expect(onboardingReducer(none, { type: 'dob-added', dob: '15/01/1990', at })).toBe(none);
    expect(needsDob(none)).toBe(false);
    expect(needsDob(null)).toBe(false);
  });
});
