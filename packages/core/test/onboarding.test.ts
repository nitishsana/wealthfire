import { describe, expect, it } from 'vitest';
import {
  OTP_RULES, canSend, demoData, deserialize, emptyData, emptyOnboarding, groupAadhaar, maskAadhaar, maskEmail,
  maskMobile, maskPan, normalizeAadhaar, normalizeEmail, normalizeMobile, normalizePan, onboardingReducer,
  panSurnameWarning, prefillProfileName, pruneSends, resumeStep, serialize, validateAadhaar, validateEmail,
  validateMobile, validateName, validatePan, verhoeffValid, type OnboardingEvent, type OnboardingState,
} from '../src';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 6, 6, 0, 0);

describe('email and mobile', () => {
  it('valid email, normalized', () => {
    expect(validateEmail('nitish@gmail.com')).toBeNull();
    expect(normalizeEmail('  Nitish@GMail.COM ')).toBe('nitish@gmail.com');
    expect(validateEmail('  Nitish@GMail.COM ')).toBeNull();
  });
  it('bad emails', () => {
    for (const e of ['', 'nitish', 'a@b', 'a@b.c', 'a b@c.com', `${'a'.repeat(250)}@b.com`]) {
      expect(validateEmail(e)).toBe('Enter a valid email address.');
    }
  });
  it('valid mobile; +91, 0, spaces and dashes stripped', () => {
    expect(validateMobile('9876543210')).toBeNull();
    expect(normalizeMobile('+91 98765-43210')).toBe('9876543210');
    expect(normalizeMobile('09876543210')).toBe('9876543210');
    expect(validateMobile('+91 98765 43210')).toBeNull();
    expect(validateMobile('6000000000')).toBeNull();
  });
  it('rejects start digit 5, 9 or 11 digits', () => {
    const msg = 'Enter a valid 10-digit mobile number.';
    expect(validateMobile('5876543210')).toBe(msg);
    expect(validateMobile('987654321')).toBe(msg);
    expect(validateMobile('98765432101')).toBe(msg);
    expect(validateMobile('98765abc10')).toBe(msg);
  });
});

describe('names', () => {
  const msg = 'Use 1–50 letters.';
  it('accepts Unicode letters, apostrophe, hyphen, dot, space', () => {
    expect(validateName('Nitish')).toBeNull();
    expect(validateName('  Sana ')).toBeNull();
    expect(validateName('नितीश')).toBeNull();
    expect(validateName("D'Souza")).toBeNull();
    expect(validateName('Mary-Jane')).toBeNull();
    expect(validateName('A. K.')).toBeNull();
    expect(validateName('a'.repeat(50))).toBeNull();
  });
  it('rejects empty, 51 chars, digits, leading symbol', () => {
    expect(validateName('')).toBe(msg);
    expect(validateName('   ')).toBe(msg);
    expect(validateName('a'.repeat(51))).toBe(msg);
    expect(validateName('Nitish2')).toBe(msg);
    expect(validateName('-Nitish')).toBe(msg);
  });
});

describe('PAN', () => {
  it('valid individual, lower-case normalized', () => {
    expect(validatePan('ABCPE1234F')).toBeNull();
    expect(normalizePan(' abcpe1234f ')).toBe('ABCPE1234F');
    expect(validatePan('abcpe1234f')).toBeNull();
  });
  it('company PAN gets the non-individual message', () => {
    expect(validatePan('ABCCE1234F')).toBe('This looks like a non-individual PAN. Use your personal PAN.');
    expect(validatePan('ABCTE1234F')).toBe('This looks like a non-individual PAN. Use your personal PAN.');
  });
  it('bad shape', () => {
    for (const p of ['', 'ABCPE1234', 'ABCPE12345', '1BCPE1234F', 'ABCZE1234F', 'ABCPE12E4F']) {
      expect(validatePan(p)).toBe('Enter a valid PAN, like ABCPE1234F.');
    }
  });
  it('surname warning on and off', () => {
    expect(panSurnameWarning('ABCPS1234F', 'Sana')).toBeNull();
    expect(panSurnameWarning('abcps1234f', 'sana')).toBeNull();
    expect(panSurnameWarning('ABCPE1234F', 'Sana')).toBe("PAN's 5th letter usually matches your last name");
    expect(panSurnameWarning('ABCPE1234F', '')).toBeNull();
  });
});

describe('Aadhaar', () => {
  const msg = 'Enter a valid 12-digit Aadhaar number.';
  it('Verhoeff pass and fail', () => {
    expect(verhoeffValid('234123412346')).toBe(true);
    expect(verhoeffValid('234123412347')).toBe(false);
    expect(verhoeffValid('')).toBe(false);
    expect(validateAadhaar('234123412346')).toBeNull();
    expect(validateAadhaar('2341 2341 2346')).toBeNull();
    expect(validateAadhaar('234123412347')).toBe(msg);
  });
  it('first digit 0 or 1 fails, 11 digits fails', () => {
    expect(validateAadhaar('034123412346')).toBe(msg);
    expect(validateAadhaar('134123412346')).toBe(msg);
    expect(validateAadhaar('23412341234')).toBe(msg);
  });
  it('grouping and masking', () => {
    expect(normalizeAadhaar('2341-2341 2346')).toBe('234123412346');
    expect(groupAadhaar('234123412346')).toBe('2341 2341 2346');
    expect(groupAadhaar('23412')).toBe('2341 2');
    expect(groupAadhaar('')).toBe('');
    expect(maskAadhaar('2346')).toBe('XXXX XXXX 2346');
  });
  it('other masks', () => {
    expect(maskEmail('nitish@gmail.com')).toBe('n*****@gmail.com');
    expect(maskMobile('9876543210')).toBe('+91 ******3210');
    expect(maskPan('ABCPE1234F')).toBe('ABCPE****F');
  });
});

describe('OTP rules', () => {
  it('cooldown at 29 s vs 30 s', () => {
    const sends = [iso(T0)];
    expect(canSend(sends, T0 + 29_000)).toEqual({ ok: false, reason: 'cooldown', waitMs: 1_000 });
    expect(canSend(sends, T0 + 30_000)).toEqual({ ok: true });
    expect(canSend([], T0)).toEqual({ ok: true });
  });
  it('4th send ok, 5th blocked within 10 minutes', () => {
    const three = [0, 1, 2].map((m) => iso(T0 + m * 60_000));
    expect(canSend(three, T0 + 3 * 60_000)).toEqual({ ok: true });
    const four = [...three, iso(T0 + 3 * 60_000)];
    expect(canSend(four, T0 + 4 * 60_000)).toEqual({ ok: false, reason: 'limit', waitMs: 6 * 60_000 });
  });
  it('window slides', () => {
    const four = [0, 1, 2, 3].map((m) => iso(T0 + m * 60_000));
    expect(canSend(four, T0 + OTP_RULES.windowMs).ok).toBe(true);
    expect(pruneSends(four, T0 + OTP_RULES.windowMs)).toHaveLength(3);
    expect(pruneSends(four, T0 + 20 * 60_000)).toEqual([]);
  });
  it('lock holds until 30 minutes pass', () => {
    const until = iso(T0 + OTP_RULES.aadhaarLockMs);
    expect(canSend([], T0, until)).toEqual({ ok: false, reason: 'locked', waitMs: 30 * 60_000 });
    expect(canSend([], T0 + OTP_RULES.aadhaarLockMs - 1, until).ok).toBe(false);
    expect(canSend([], T0 + OTP_RULES.aadhaarLockMs, until)).toEqual({ ok: true });
    expect(canSend([], T0, null)).toEqual({ ok: true });
  });
});

function runHappyPath(): OnboardingState {
  const events: OnboardingEvent[] = [
    { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '+91 98765 43210' } },
    { type: 'contact-verified', at: iso(T0 + 10_000) },
    { type: 'identity-saved', firstName: ' Nitish ', lastName: 'Sana', pan: 'abcps1234f' },
    { type: 'otp-sent', channel: 'aadhaar', at: iso(T0 + 20_000) },
    { type: 'aadhaar-verified', last4: '2346', at: iso(T0 + 30_000), provider: 'demo' },
  ];
  return events.reduce(onboardingReducer, emptyOnboarding());
}

describe('reducer', () => {
  it('happy path signin → done', () => {
    let s = emptyOnboarding();
    s = onboardingReducer(s, { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'email', value: ' Nitish@Gmail.com' } });
    expect(s.step).toBe('otp');
    expect(s.contact).toEqual({ kind: 'email', value: 'nitish@gmail.com', verifiedAt: null });
    expect(s.sends.contact).toEqual([iso(T0)]);
    s = onboardingReducer(s, { type: 'otp-sent', channel: 'contact', at: iso(T0 + 30_000) }); // resend
    expect(s.sends.contact).toHaveLength(2);
    s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0 + 40_000) });
    expect(s.step).toBe('identity');
    expect(s.contact?.verifiedAt).toBe(iso(T0 + 40_000));

    const done = runHappyPath();
    expect(done.step).toBe('done');
    expect(done.identity).toEqual({ firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F' });
    expect(done.contact?.value).toBe('9876543210');
    expect(done.aadhaar).toEqual({ last4: '2346', verifiedAt: iso(T0 + 30_000), provider: 'demo' });
    expect(done.completedAt).toBe(iso(T0 + 30_000));
    expect(done.sends.aadhaar).toEqual([iso(T0 + 20_000)]);
    expect(resumeStep(done)).toBe('done');
  });

  it('change contact and back to identity', () => {
    let s = onboardingReducer(emptyOnboarding(), { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
    s = onboardingReducer(s, { type: 'change-contact' });
    expect(s.step).toBe('signin');
    expect(s.contact).toBeNull();
    s = onboardingReducer(s, { type: 'otp-sent', channel: 'contact', at: iso(T0 + 60_000), contact: { kind: 'mobile', value: '9876543210' } });
    s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0 + 70_000) });
    s = onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F' });
    expect(s.step).toBe('aadhaar-otp');
    s = onboardingReducer(s, { type: 'back-to-identity' });
    expect(s.step).toBe('identity');
    expect(s.identity?.pan).toBe('ABCPS1234F');
  });

  it('wrong-step and invalid events are ignored', () => {
    const start = emptyOnboarding();
    const ignored: OnboardingEvent[] = [
      { type: 'contact-verified', at: iso(T0) },
      { type: 'change-contact' },
      { type: 'identity-saved', firstName: 'A', lastName: 'B', pan: 'ABCPB1234F' },
      { type: 'back-to-identity' },
      { type: 'aadhaar-verified', last4: '2346', at: iso(T0), provider: 'demo' },
      { type: 'aadhaar-locked', until: iso(T0) },
      { type: 'otp-sent', channel: 'aadhaar', at: iso(T0) },
      { type: 'otp-sent', channel: 'contact', at: iso(T0) }, // no contact given
      { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '123' } },
    ];
    for (const e of ignored) expect(onboardingReducer(start, e)).toBe(start);

    let s = onboardingReducer(start, { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
    s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0) });
    // invalid identity is ignored
    for (const e of [
      { type: 'identity-saved', firstName: '', lastName: 'Sana', pan: 'ABCPS1234F' },
      { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCCS1234F' },
    ] as OnboardingEvent[]) expect(onboardingReducer(s, e)).toBe(s);
  });

  it('done only via aadhaar-verified with 4 digits', () => {
    let s = onboardingReducer(emptyOnboarding(), { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
    s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0) });
    s = onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F' });
    expect(onboardingReducer(s, { type: 'aadhaar-verified', last4: '234123412346', at: iso(T0), provider: 'demo' })).toBe(s);
    expect(onboardingReducer(s, { type: 'aadhaar-verified', last4: '12a4', at: iso(T0), provider: 'demo' })).toBe(s);
    const locked = onboardingReducer(s, { type: 'aadhaar-locked', until: iso(T0 + OTP_RULES.aadhaarLockMs) });
    expect(locked.aadhaarLockedUntil).toBe(iso(T0 + OTP_RULES.aadhaarLockMs));
    expect(locked.step).toBe('aadhaar-otp');
    expect(onboardingReducer(s, { type: 'aadhaar-verified', last4: '2346', at: iso(T0), provider: 'demo' }).step).toBe('done');
  });

  it('sign-out resets onboarding only', () => {
    const data = { ...demoData(new Date(T0)), onboarding: runHappyPath() };
    const out = { ...data, onboarding: onboardingReducer(data.onboarding, { type: 'sign-out' }) };
    expect(out.onboarding).toEqual(emptyOnboarding());
    expect(out.assets).toEqual(data.assets);
    expect(out.profile).toEqual(data.profile);
  });

  it('prefillProfileName', () => {
    const d = emptyData();
    expect(prefillProfileName(d)).toBe('');
    d.onboarding = runHappyPath();
    expect(prefillProfileName(d)).toBe('Nitish Sana');
    const demo = { ...demoData(new Date(T0)), onboarding: d.onboarding };
    expect(prefillProfileName(demo)).toBe('Demo User');
    expect(prefillProfileName({ ...demo, profile: { ...demo.profile!, name: '' } })).toBe('Nitish Sana');
  });
});

describe('store', () => {
  it('old JSON without onboarding loads as signin and keeps assets', () => {
    const old = demoData(new Date(T0)) as Partial<ReturnType<typeof demoData>>;
    delete old.onboarding;
    const d = deserialize(JSON.stringify(old));
    expect(d.onboarding).toEqual(emptyOnboarding());
    expect(d.onboarding.step).toBe('signin');
    expect(d.assets).toHaveLength(8);
    expect(emptyData().onboarding).toEqual(emptyOnboarding());
    expect(demoData().onboarding).toEqual(emptyOnboarding());
  });

  it('round-trips a finished onboarding', () => {
    const d = { ...emptyData(), onboarding: runHappyPath() };
    expect(deserialize(serialize(d)).onboarding).toEqual(d.onboarding);
  });

  it('hand-edited done without aadhaar resets to aadhaar-otp', () => {
    const o = { ...runHappyPath(), aadhaar: null };
    expect(deserialize(JSON.stringify({ ...emptyData(), onboarding: o })).onboarding.step).toBe('aadhaar-otp');
    const full = { ...runHappyPath(), aadhaar: { last4: '234123412346', verifiedAt: iso(T0), provider: 'demo' } };
    const back = deserialize(JSON.stringify({ ...emptyData(), onboarding: full })).onboarding;
    expect(back.aadhaar).toBeNull();
    expect(back.step).toBe('aadhaar-otp');
    expect(back.completedAt).toBeNull();
  });

  it('drops invalid identity and contact values', () => {
    const load = (o: object) => deserialize(JSON.stringify({ ...emptyData(), onboarding: { ...runHappyPath(), ...o } })).onboarding;
    for (const identity of [
      { firstName: 'Nitish', lastName: 'Sana', pan: 'ABCCS1234F' },
      { firstName: 'Nitish', lastName: 'Sana', pan: 'NOTAPAN' },
      { firstName: 'N1tish', lastName: 'Sana', pan: 'ABCPS1234F' },
      { firstName: 'Nitish', lastName: '', pan: 'ABCPS1234F' },
    ]) {
      const s = load({ identity });
      expect(s.identity).toBeNull();
      expect(s.step).toBe('identity');
    }
    for (const contact of [
      { kind: 'mobile', value: '12345', verifiedAt: iso(T0) },
      { kind: 'email', value: 'not-an-email', verifiedAt: iso(T0) },
      { kind: 'email', value: '9876543210', verifiedAt: iso(T0) },
      { kind: 'fax', value: '9876543210', verifiedAt: iso(T0) },
    ]) {
      const s = load({ contact });
      expect(s.contact).toBeNull();
      expect(s.step).toBe('signin');
    }
    expect(load({ contact: { kind: 'email', value: ' A@B.com', verifiedAt: iso(T0) } }).contact?.value).toBe('a@b.com');
    expect(load({ identity: { firstName: ' Nitish', lastName: 'Sana', pan: 'abcps1234f' } }).identity)
      .toEqual({ firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F' });
  });

  it('drops unknown keys and steps with missing data', () => {
    const raw = { ...runHappyPath(), fullAadhaar: '234123412346', otp: '123456' };
    const back = deserialize(JSON.stringify({ ...emptyData(), onboarding: raw })).onboarding;
    expect(Object.keys(back).sort()).toEqual(Object.keys(emptyOnboarding()).sort());
    const noContact = deserialize(JSON.stringify({ ...emptyData(), onboarding: { ...raw, contact: null } })).onboarding;
    expect(noContact.step).toBe('signin');
    const badStep = deserialize(JSON.stringify({ ...emptyData(), onboarding: { step: 'nope' } })).onboarding;
    expect(badStep).toEqual(emptyOnboarding());
    expect(deserialize(JSON.stringify({ ...emptyData(), onboarding: 'x' })).onboarding).toEqual(emptyOnboarding());
  });

  it('serialized data after a full happy path never contains a 12-digit run', () => {
    const json = serialize({ ...demoData(new Date(T0)), onboarding: runHappyPath() });
    expect(json).not.toMatch(/\d{12}/);
  });
});
