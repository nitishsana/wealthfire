import { describe, expect, it } from 'vitest';
import {
  OTP_RULES, canSend, demoData, deserialize, emptyData, emptyOnboarding, groupAadhaar, maskAadhaar, maskEmail,
  maskMobile, maskPan, normalizeAadhaar, normalizeEmail, normalizeMobile, normalizePan, onboardingReducer,
  panSurnameWarning, prefillProfileName, pruneSends, resumeStep, serialize, validateAadhaar, validateEmail,
  validateMobile, validateName, validatePan, verhoeffValid, verhoeffCheckDigit, emptyKyc, isEligibleToInvest,
  sanitizeOnboarding, readBlocked, readsLeft, resendIn, confirmAadhaarRetype, type OnboardingEvent, type OnboardingState,
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


/** Signed in, contact verified, details saved: state is on 'aadhaar-otp'. */
function toAadhaarOtp(): OnboardingState {
  let s = onboardingReducer(emptyOnboarding(), { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
  s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0) });
  return onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' });
}

/** Aadhaar OTP passed: state is on 'documents'. */
function toDocuments(): OnboardingState {
  return onboardingReducer(toAadhaarOtp(), { type: 'aadhaar-verified', last4: '2346', at: iso(T0 + 5_000), provider: 'demo' });
}

function runHappyPath(): OnboardingState {
  const events: OnboardingEvent[] = [
    { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '+91 98765 43210' } },
    { type: 'contact-verified', at: iso(T0 + 10_000) },
    { type: 'identity-saved', firstName: ' Nitish ', lastName: 'Sana', pan: 'abcps1234f', dob: '1990-01-15' },
    { type: 'otp-sent', channel: 'aadhaar', at: iso(T0 + 20_000) },
    { type: 'aadhaar-verified', last4: '2346', at: iso(T0 + 30_000), provider: 'demo' },
    { type: 'documents-ready', at: iso(T0 + 35_000), reader: 'ondevice' },
    { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at: iso(T0 + 40_000) },
  ];
  return events.reduce(onboardingReducer, emptyOnboarding());
}

const PAN_REVIEW = [{ field: 'pan' as const, typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z' }];

/** Done and under review for the PAN (one re-read used). */
function toReviewDone(at = iso(T0 + 50_000)): OnboardingState {
  let s = onboardingReducer(toDocuments(), { type: 'documents-ready', at: iso(T0 + 6_000), reader: 'demo' });
  s = onboardingReducer(s, { type: 'reread-used', field: 'pan' });
  return onboardingReducer(s, { type: 'check-confirmed', match: 'review', pan: 'ABCPS1234F', fields: PAN_REVIEW, at });
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
    expect(done.identity).toEqual({ firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' });
    expect(done.contact?.value).toBe('9876543210');
    expect(done.aadhaar).toEqual({ last4: '2346', verifiedAt: iso(T0 + 30_000), provider: 'demo' });
    expect(done.completedAt).toBe(iso(T0 + 40_000));
    expect(done.sends.aadhaar).toEqual([iso(T0 + 20_000)]);
    expect(resumeStep(done)).toBe('done');
  });

  it('change contact and back to identity (from aadhaar-otp only)', () => {
    let s = onboardingReducer(emptyOnboarding(), { type: 'otp-sent', channel: 'contact', at: iso(T0), contact: { kind: 'mobile', value: '9876543210' } });
    s = onboardingReducer(s, { type: 'change-contact' });
    expect(s.step).toBe('signin');
    expect(s.contact).toBeNull();
    s = onboardingReducer(s, { type: 'otp-sent', channel: 'contact', at: iso(T0 + 60_000), contact: { kind: 'mobile', value: '9876543210' } });
    s = onboardingReducer(s, { type: 'contact-verified', at: iso(T0 + 70_000) });
    s = onboardingReducer(s, { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' });
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
      { type: 'identity-saved', firstName: 'A', lastName: 'B', pan: 'ABCPB1234F', dob: '1990-01-15' },
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
      { type: 'identity-saved', firstName: '', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' },
      { type: 'identity-saved', firstName: 'Nitish', lastName: 'Sana', pan: 'ABCCS1234F', dob: '1990-01-15' },
    ] as OnboardingEvent[]) expect(onboardingReducer(s, e)).toBe(s);
  });

  it('aadhaar-verified needs 4 digits and goes to documents, not done', () => {
    const s = toAadhaarOtp();
    expect(onboardingReducer(s, { type: 'aadhaar-verified', last4: '234123412346', at: iso(T0), provider: 'demo' })).toBe(s);
    expect(onboardingReducer(s, { type: 'aadhaar-verified', last4: '12a4', at: iso(T0), provider: 'demo' })).toBe(s);
    const locked = onboardingReducer(s, { type: 'aadhaar-locked', until: iso(T0 + OTP_RULES.aadhaarLockMs) });
    expect(locked.aadhaarLockedUntil).toBe(iso(T0 + OTP_RULES.aadhaarLockMs));
    expect(locked.step).toBe('aadhaar-otp');
    const docs = onboardingReducer(s, { type: 'aadhaar-verified', last4: '2346', at: iso(T0), provider: 'demo' });
    expect(docs.step).toBe('documents');
    expect(docs.aadhaar).toEqual({ last4: '2346', verifiedAt: iso(T0), provider: 'demo' });
    expect(docs.completedAt).toBeNull();
    expect(docs.kyc.status).toBeNull();
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
    expect(load({ identity: { firstName: ' Nitish', lastName: 'Sana', pan: 'abcps1234f', dob: '15/01/1990' } }).identity)
      .toEqual({ firstName: 'Nitish', lastName: 'Sana', pan: 'ABCPS1234F', dob: '1990-01-15' });
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

describe('Part B: verhoeffCheckDigit', () => {
  it('builds 234123412346 from 23412341234', () => {
    expect('23412341234' + verhoeffCheckDigit('23412341234')).toBe('234123412346');
    expect(verhoeffCheckDigit('23412341234')).toBe('6');
  });
  it('always makes a Verhoeff-valid number', () => {
    for (const p of ['49911866524', '98765432101', '20000000000', '55555555555']) {
      expect(verhoeffValid(p + verhoeffCheckDigit(p))).toBe(true);
    }
    expect(() => verhoeffCheckDigit('12a')).toThrow();
  });
});

describe('Part C: reducer order (Aadhaar OTP once, before documents)', () => {
  const at = iso(T0 + 50_000);

  it('identity → aadhaar-otp → documents → check → done', () => {
    let s = toAadhaarOtp();
    expect(s.step).toBe('aadhaar-otp');
    s = onboardingReducer(s, { type: 'aadhaar-verified', last4: '2346', at, provider: 'demo' });
    expect(s.step).toBe('documents');
    expect(s.kyc).toEqual(emptyKyc());
    s = onboardingReducer(s, { type: 'documents-ready', at, reader: 'ondevice' });
    expect(s.step).toBe('check');
    expect(s.kyc).toMatchObject({ documentsAt: at, reader: 'ondevice' });
    s = onboardingReducer(s, { type: 'back-to-documents' });
    expect(s.step).toBe('documents');
  });

  it('full path signin → done (pre-verified, not eligible until the final KYC approval)', () => {
    const done = runHappyPath();
    expect(done.step).toBe('done');
    expect(done.kyc).toMatchObject({ match: 'matched', status: 'pre-verified', review: null, reader: 'ondevice' });
    expect(isEligibleToInvest({ ...emptyData(), onboarding: done })).toBe(false);
    const final = onboardingReducer(done, { type: 'review-decided', result: 'approved', reason: null, at });
    expect(final.kyc.status).toBe('verified');
    expect(isEligibleToInvest({ ...emptyData(), onboarding: final })).toBe(true);
  });

  it('pre-verified approval creates a decided record (fields [], id/sentAt from at)', () => {
    const done = runHappyPath();
    const final = onboardingReducer(done, { type: 'review-decided', result: 'approved', reason: 'ignored', at });
    expect(final.kyc.review).toEqual({
      id: `rv_${Date.parse(at).toString(36)}`, sentAt: at, fields: [], decision: { result: 'approved', reason: null, at },
    });
    // a pre-verified account can't be rejected, bad times are ignored, and the result survives a reload
    expect(onboardingReducer(done, { type: 'review-decided', result: 'rejected', reason: 'Blurred', at })).toBe(done);
    expect(onboardingReducer(done, { type: 'review-decided', result: 'approved', reason: null, at: 'nope' })).toBe(done);
    expect(sanitizeOnboarding(JSON.parse(JSON.stringify(final))).kyc.status).toBe('verified');
    expect(JSON.stringify(final)).not.toMatch(/\d{12}/);
  });

  it('pre-verified after a rejected round: approval replaces the old decided record', () => {
    const no = onboardingReducer(toReviewDone(at), { type: 'review-decided', result: 'rejected', reason: 'Blurred', at });
    let s = onboardingReducer(no, { type: 'redo-documents' });
    s = onboardingReducer(s, { type: 'documents-ready', at, reader: 'demo' });
    s = onboardingReducer(s, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at });
    const at2 = iso(T0 + 99_000);
    const ok = onboardingReducer(s, { type: 'review-decided', result: 'approved', reason: null, at: at2 });
    expect(ok.kyc.status).toBe('verified');
    expect(ok.kyc.review).toEqual({ id: `rv_${(T0 + 99_000).toString(36)}`, sentAt: at2, fields: [], decision: { result: 'approved', reason: null, at: at2 } });
  });

  it('check-confirmed saves the final PAN and finishes', () => {
    let s = onboardingReducer(toDocuments(), { type: 'documents-ready', at, reader: 'demo' });
    s = onboardingReducer(s, { type: 'check-confirmed', match: 'matched', pan: 'abcpz1234f', fields: [], at });
    expect(s.step).toBe('done');
    expect(s.completedAt).toBe(at);
    expect(s.identity?.pan).toBe('ABCPZ1234F');
    expect(s.identity?.firstName).toBe('Nitish');
  });

  it('path with review → under-review, id (base 36) and sentAt set on Confirm', () => {
    const done = toReviewDone(at);
    expect(done.step).toBe('done');
    expect(done.completedAt).toBe(at);
    expect(done.kyc.match).toBe('review');
    expect(done.kyc.status).toBe('under-review');
    expect(done.kyc.rereads).toEqual({ pan: 1, aadhaar: 0 });
    expect(done.kyc.review).toEqual({ id: `rv_${(T0 + 50_000).toString(36)}`, sentAt: at, decision: null, fields: PAN_REVIEW });
    expect(isEligibleToInvest({ ...emptyData(), onboarding: done })).toBe(false);
  });

  it('done only via check-confirmed after aadhaar-verified', () => {
    // Hand-built: on check without a verified Aadhaar.
    const check = onboardingReducer(toDocuments(), { type: 'documents-ready', at, reader: 'demo' });
    const noAadhaar: OnboardingState = { ...check, aadhaar: null };
    expect(onboardingReducer(noAadhaar, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at })).toBe(noAadhaar);
    // documents-ready also needs the Aadhaar OTP.
    const docsNoAadhaar: OnboardingState = { ...toDocuments(), aadhaar: null };
    expect(onboardingReducer(docsNoAadhaar, { type: 'documents-ready', at, reader: 'demo' })).toBe(docsNoAadhaar);
    // aadhaar-verified never finishes onboarding.
    expect(onboardingReducer(toAadhaarOtp(), { type: 'aadhaar-verified', last4: '2346', at, provider: 'demo' }).step).toBe('documents');
    // bad time is ignored
    expect(onboardingReducer(check, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at: 'nope' })).toBe(check);
  });

  it('Aadhaar is locked on check: no back-to-identity; review must show the verified Aadhaar as typed', () => {
    const docs = toDocuments();
    const check = onboardingReducer(docs, { type: 'documents-ready', at, reader: 'demo' });
    expect(onboardingReducer(docs, { type: 'back-to-identity' })).toBe(docs);
    expect(onboardingReducer(check, { type: 'back-to-identity' })).toBe(check);
    const other = { type: 'check-confirmed', match: 'review', pan: 'ABCPS1234F', at,
      fields: [{ field: 'aadhaar', typedMasked: 'XXXX XXXX 5246', readMasked: 'XXXX XXXX 5246' }] } as OnboardingEvent;
    expect(onboardingReducer(check, other)).toBe(check);
    const ok = onboardingReducer(check, {
      type: 'check-confirmed', match: 'review', pan: 'ABCPS1234F', at,
      fields: [{ field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 5246' }],
    });
    expect(ok.kyc.status).toBe('under-review');
    expect(ok.aadhaar?.last4).toBe('2346');
  });

  it('review-decided approve → verified', () => {
    const done = toReviewDone(at);
    const ok = onboardingReducer(done, { type: 'review-decided', result: 'approved', reason: 'ignored', at });
    expect(ok.kyc.status).toBe('verified');
    expect(ok.kyc.review?.decision).toEqual({ result: 'approved', reason: null, at });
    expect(onboardingReducer(ok, { type: 'review-decided', result: 'rejected', reason: 'x', at })).toBe(ok);
  });

  it('review-decided reject needs a 1–200 char reason', () => {
    const done = toReviewDone(at);
    expect(onboardingReducer(done, { type: 'review-decided', result: 'rejected', reason: null, at })).toBe(done);
    expect(onboardingReducer(done, { type: 'review-decided', result: 'rejected', reason: '   ', at })).toBe(done);
    expect(onboardingReducer(done, { type: 'review-decided', result: 'rejected', reason: 'x'.repeat(201), at })).toBe(done);
    const no = onboardingReducer(done, { type: 'review-decided', result: 'rejected', reason: ' PAN photo is blurred ', at });
    expect(no.kyc.status).toBe('rejected');
    expect(no.kyc.review?.decision).toEqual({ result: 'rejected', reason: 'PAN photo is blurred', at });
  });

  it('redo-documents → documents, Aadhaar kept (no new OTP), kyc reset but review history kept', () => {
    const done = toReviewDone(at);
    const no = onboardingReducer(done, { type: 'review-decided', result: 'rejected', reason: 'Blurred', at });
    const redo = onboardingReducer(no, { type: 'redo-documents' });
    expect(redo.step).toBe('documents');
    expect(redo.identity).toEqual(no.identity);
    expect(redo.aadhaar).toEqual(no.aadhaar);
    expect(redo.sends).toEqual(no.sends);
    expect(redo.completedAt).toBeNull();
    expect(redo.kyc).toEqual({ ...emptyKyc(), review: no.kyc.review });
    expect(onboardingReducer(done, { type: 'redo-documents' })).toBe(done);
    // a new review replaces the old one
    let s = onboardingReducer(redo, { type: 'documents-ready', at, reader: 'demo' });
    s = onboardingReducer(s, {
      type: 'check-confirmed', match: 'review', pan: 'ABCPS1234F', at: iso(T0 + 90_000),
      fields: [{ field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'XXXX XXXX 5246' }],
    });
    expect(s.kyc.review?.fields[0]?.field).toBe('aadhaar');
    expect(s.kyc.review?.decision).toBeNull();
    expect(s.kyc.review?.id).toBe(`rv_${(T0 + 90_000).toString(36)}`);
  });

  it('reread-used is capped at 2', () => {
    let s = onboardingReducer(toDocuments(), { type: 'documents-ready', at, reader: 'demo' });
    for (let i = 0; i < 4; i++) s = onboardingReducer(s, { type: 'reread-used', field: 'aadhaar' });
    expect(s.kyc.rereads).toEqual({ pan: 0, aadhaar: 2 });
  });

  it('back-to-check no longer exists; wrong-step events are ignored', () => {
    const docs = toDocuments();
    const check = onboardingReducer(docs, { type: 'documents-ready', at, reader: 'demo' });
    const cases: [OnboardingState, OnboardingEvent][] = [
      [toAadhaarOtp(), { type: 'documents-ready', at, reader: 'demo' }],
      [docs, { type: 'back-to-documents' }],
      [docs, { type: 'reread-used', field: 'pan' }],
      [docs, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at }],
      [docs, { type: 'aadhaar-verified', last4: '2346', at, provider: 'demo' }],
      [docs, { type: 'review-decided', result: 'approved', reason: null, at }],
      [docs, { type: 'redo-documents' }],
      [check, { type: 'back-to-check' } as unknown as OnboardingEvent],
      [check, { type: 'documents-ready', at, reader: 'demo' }],
      [check, { type: 'check-confirmed', match: 'matched', pan: 'ABCCS1234F', fields: [], at }],
      [check, { type: 'check-confirmed', match: 'review', pan: 'ABCPS1234F', fields: [], at }],
      [check, {
        type: 'check-confirmed', match: 'review', pan: 'ABCPS1234F', at,
        fields: [{ field: 'aadhaar', typedMasked: '234123412346', readMasked: 'XXXX XXXX 1234' }],
      }],
      [runHappyPath(), { type: 'review-decided', result: 'rejected', reason: 'Blurred', at }],
      [runHappyPath(), { type: 'redo-documents' }],
      [runHappyPath(), { type: 'back-to-identity' }],
      [emptyOnboarding(), { type: 'documents-ready', at, reader: 'demo' }],
    ];
    for (const [s, e] of cases) expect(onboardingReducer(s, e)).toBe(s);
  });

  it('sign-out clears kyc too', () => {
    expect(onboardingReducer(runHappyPath(), { type: 'sign-out' }).kyc).toEqual(emptyKyc());
  });
});

describe('Part C: confirmAadhaarRetype', () => {
  it('ok when valid and ends in the verified last 4', () => {
    expect(confirmAadhaarRetype('2341 2341 2346', '2346')).toBeNull();
    expect(confirmAadhaarRetype('234123412346', '2346')).toBeNull();
  });
  it('invalid number', () => {
    for (const v of ['', '23412341234', '234123412347', '134123412346']) {
      expect(confirmAadhaarRetype(v, '2346')).toBe('Enter a valid 12-digit Aadhaar number.');
    }
  });
  it('valid but a different Aadhaar', () => {
    expect(confirmAadhaarRetype('499118665246', '2346')).toBe("This doesn't match the Aadhaar you verified.");
    expect(confirmAadhaarRetype('234123412346', '5246')).toBe("This doesn't match the Aadhaar you verified.");
  });
});

describe('Part C: store', () => {
  const reviewRejected = () =>
    onboardingReducer(toReviewDone(iso(T0)), { type: 'review-decided', result: 'rejected', reason: 'Blurred', at: iso(T0) });

  it('serialized data after a review path has no 12-digit run', () => {
    const json = serialize({ ...demoData(new Date(T0)), onboarding: reviewRejected() });
    expect(json).not.toMatch(/\d{12}/);
    expect(deserialize(json).onboarding).toEqual(reviewRejected());
  });

  it('old done without kyc is lowered to documents (Aadhaar already verified)', () => {
    const { kyc: _drop, ...old } = runHappyPath();
    const back = deserialize(JSON.stringify({ ...emptyData(), onboarding: old })).onboarding;
    expect(back.step).toBe('documents');
    expect(back.kyc).toEqual(emptyKyc());
    expect(back.completedAt).toBeNull();
    expect(back.aadhaar?.last4).toBe('2346');
  });

  it('done needs kyc.match and kyc.status', () => {
    const done = runHappyPath();
    expect(sanitizeOnboarding({ ...done, kyc: { ...done.kyc, status: null } }).step).toBe('documents');
    expect(sanitizeOnboarding({ ...done, kyc: { ...done.kyc, match: null } }).step).toBe('documents');
    expect(sanitizeOnboarding(done).step).toBe('done');
  });

  it('steps past aadhaar-otp need the Aadhaar OTP', () => {
    for (const step of ['documents', 'check', 'done']) {
      expect(sanitizeOnboarding({ ...runHappyPath(), step, aadhaar: null }).step).toBe('aadhaar-otp');
    }
    expect(sanitizeOnboarding(toAadhaarOtp()).step).toBe('aadhaar-otp');
    expect(sanitizeOnboarding(toDocuments()).step).toBe('documents');
  });

  it('a stored check opens on documents after reload (reads were in memory only)', () => {
    const check = onboardingReducer(toDocuments(), { type: 'documents-ready', at: iso(T0), reader: 'demo' });
    expect(sanitizeOnboarding(check).step).toBe('documents');
    expect(sanitizeOnboarding(check).kyc.documentsAt).toBe(iso(T0));
  });

  it('unknown kyc → empty; rereads clamped; bad masks dropped; ondevice reader kept', () => {
    expect(sanitizeOnboarding({ ...runHappyPath(), kyc: 'x' }).kyc).toEqual(emptyKyc());
    expect(sanitizeOnboarding(runHappyPath()).kyc.reader).toBe('ondevice');
    const k = sanitizeOnboarding({
      ...reviewRejected(),
      kyc: {
        ...reviewRejected().kyc,
        match: 'maybe', status: 'gold', reader: 'ocr', rereads: { pan: 7, aadhaar: -3 }, extra: 1,
        review: {
          ...reviewRejected().kyc.review,
          fields: [
            { field: 'aadhaar', typedMasked: '234123412346', readMasked: 'XXXX XXXX 1234' },
            { field: 'aadhaar', typedMasked: 'XXXX XXXX 2346', readMasked: 'xxxx' },
            { field: 'name', typedMasked: 'ABCPS****F', readMasked: 'ABCPS****F' },
            { field: 'pan', typedMasked: 'ABCPS****F', readMasked: 'AAAPZ****Z' },
          ],
        },
      },
    }).kyc;
    expect(k.match).toBeNull();
    expect(k.status).toBeNull();
    expect(k.reader).toBeNull();
    expect(k.rereads).toEqual({ pan: 2, aadhaar: 0 });
    expect(k.review?.fields).toEqual(PAN_REVIEW);
    expect(Object.keys(k).sort()).toEqual(Object.keys(emptyKyc()).sort());
  });

  it('review nameMismatch survives a reload only as true', () => {
    const withFields = (fields: unknown[]) => sanitizeOnboarding({
      ...reviewRejected(),
      kyc: { ...reviewRejected().kyc, review: { ...reviewRejected().kyc.review, fields } },
    }).kyc.review?.fields;
    expect(withFields([{ ...PAN_REVIEW[0], nameMismatch: true }])).toEqual([{ ...PAN_REVIEW[0], nameMismatch: true }]);
    expect(withFields([{ ...PAN_REVIEW[0], nameMismatch: 'yes' }])).toEqual(PAN_REVIEW);
  });
});

describe('Bug 3: matched Confirm keeps only decided review history', () => {
  const at = iso(T0 + 60_000);
  it('a decided (rejected) review stays as history after a matched redo', () => {
    const no = onboardingReducer(toReviewDone(at), { type: 'review-decided', result: 'rejected', reason: 'Blurred', at });
    let s = onboardingReducer(no, { type: 'redo-documents' });
    s = onboardingReducer(s, { type: 'documents-ready', at, reader: 'demo' });
    s = onboardingReducer(s, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at });
    expect(s.kyc.status).toBe('pre-verified');
    expect(s.kyc.review).toEqual(no.kyc.review);
    expect(s.kyc.review?.decision?.result).toBe('rejected');
  });

  it('a hand-built pending review is cleared by a matched Confirm', () => {
    const check = onboardingReducer(toDocuments(), { type: 'documents-ready', at, reader: 'demo' });
    const s: OnboardingState = { ...check, kyc: { ...check.kyc, review: { id: 'rv_x', sentAt: at, fields: PAN_REVIEW, decision: null } } };
    const done = onboardingReducer(s, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at });
    expect(done.kyc).toMatchObject({ status: 'pre-verified', review: null });
  });
});

describe('Pre-verified: stored verified needs an approved review decision', () => {
  it('verified without an approved decision is lowered to pre-verified on load', () => {
    const done = runHappyPath();
    const fake = { ...done, kyc: { ...done.kyc, status: 'verified' } };
    expect(sanitizeOnboarding(fake).kyc.status).toBe('pre-verified');
    const rejected = onboardingReducer(toReviewDone(), { type: 'review-decided', result: 'rejected', reason: 'Blurred', at: iso(T0) });
    expect(sanitizeOnboarding({ ...rejected, kyc: { ...rejected.kyc, status: 'verified' } }).kyc.status).toBe('pre-verified');
    const pending = toReviewDone();
    expect(sanitizeOnboarding({ ...pending, kyc: { ...pending.kyc, status: 'verified' } }).kyc.status).toBe('pre-verified');
    expect(isEligibleToInvest({ ...emptyData(), onboarding: sanitizeOnboarding(fake) })).toBe(false);
  });
  it('verified with an approved decision stays verified; pre-verified stays pre-verified', () => {
    const approved = onboardingReducer(toReviewDone(), { type: 'review-decided', result: 'approved', reason: null, at: iso(T0) });
    expect(sanitizeOnboarding(approved).kyc.status).toBe('verified');
    expect(sanitizeOnboarding(runHappyPath()).kyc.status).toBe('pre-verified');
    expect(sanitizeOnboarding(runHappyPath()).step).toBe('done');
  });
});

describe('Bug 1: reads after Back count as re-reads', () => {
  const at = iso(T0 + 70_000);
  const toCheck = () => onboardingReducer(toDocuments(), { type: 'documents-ready', at, reader: 'demo' });
  const backAndContinue = (s: OnboardingState) =>
    onboardingReducer(onboardingReducer(s, { type: 'back-to-documents' }), { type: 'documents-ready', at, reader: 'demo' });

  it('first read is free; back-to-documents sets the flag', () => {
    const check = toCheck();
    expect(check.kyc.rereads).toEqual({ pan: 0, aadhaar: 0 });
    expect(check.kyc.returnedFromCheck).toBe(false);
    const docs = onboardingReducer(check, { type: 'back-to-documents' });
    expect(docs.kyc.returnedFromCheck).toBe(true);
  });

  it('documents-ready after Back counts one re-read per field, capped, and clears the flag', () => {
    let s = backAndContinue(toCheck());
    expect(s.kyc.rereads).toEqual({ pan: 1, aadhaar: 1 });
    expect(s.kyc.returnedFromCheck).toBe(false);
    s = backAndContinue(s);
    expect(s.kyc.rereads).toEqual({ pan: 2, aadhaar: 2 });
    s = backAndContinue(s);
    expect(s.kyc.rereads).toEqual({ pan: 2, aadhaar: 2 });
  });

  it('check-confirmed clears the flag', () => {
    const check = toCheck();
    const s: OnboardingState = { ...check, kyc: { ...check.kyc, returnedFromCheck: true } };
    const next = onboardingReducer(s, { type: 'check-confirmed', match: 'matched', pan: 'ABCPS1234F', fields: [], at });
    expect(next.kyc.returnedFromCheck).toBe(false);
  });

  it('readsLeft and readBlocked', () => {
    let s = toCheck();
    s = onboardingReducer(s, { type: 'reread-used', field: 'pan' });
    s = onboardingReducer(s, { type: 'reread-used', field: 'pan' });
    expect(readsLeft(s.kyc, 'pan')).toBe(0);
    expect(readsLeft(s.kyc, 'aadhaar')).toBe(2);
    expect(readBlocked(s.kyc, 'pan')).toBe(false);
    const docs = onboardingReducer(s, { type: 'back-to-documents' });
    expect(readBlocked(docs.kyc, 'pan')).toBe(true);
    expect(readBlocked(docs.kyc, 'aadhaar')).toBe(false);
    const again = onboardingReducer(docs, { type: 'documents-ready', at, reader: 'demo' });
    expect(again.kyc.rereads).toEqual({ pan: 2, aadhaar: 1 });
    expect(readsLeft(again.kyc, 'aadhaar')).toBe(1);
  });

  it('reload clears the flag but keeps the counts (nothing blocked without an earlier read)', () => {
    let s = toCheck();
    s = onboardingReducer(s, { type: 'reread-used', field: 'pan' });
    s = onboardingReducer(s, { type: 'reread-used', field: 'pan' });
    const docs = onboardingReducer(s, { type: 'back-to-documents' });
    expect(readBlocked(docs.kyc, 'pan')).toBe(true);
    const back = deserialize(serialize({ ...emptyData(), onboarding: docs })).onboarding;
    expect(back.step).toBe('documents');
    expect(back.kyc.returnedFromCheck).toBe(false);
    expect(back.kyc.rereads).toEqual({ pan: 2, aadhaar: 0 });
    expect(readBlocked(back.kyc, 'pan')).toBe(false);
    expect(readsLeft(back.kyc, 'pan')).toBe(0);
    // The read after reload is not counted.
    const after = onboardingReducer(back, { type: 'documents-ready', at, reader: 'demo' });
    expect(after.kyc.rereads).toEqual({ pan: 2, aadhaar: 0 });
  });

  it('sanitize: flag is always false after load', () => {
    const base = backAndContinue(toCheck());
    for (const v of [true, 'true', 1, null, undefined, {}]) {
      expect(sanitizeOnboarding({ ...base, kyc: { ...base.kyc, returnedFromCheck: v } }).kyc.returnedFromCheck).toBe(false);
    }
    const { returnedFromCheck: _drop, ...old } = base.kyc;
    expect(sanitizeOnboarding({ ...base, kyc: old }).kyc.returnedFromCheck).toBe(false);
    expect(emptyKyc().returnedFromCheck).toBe(false);
  });
});

describe('resendIn', () => {
  it('formats M:SS, rounding up', () => {
    expect(resendIn(7_000)).toBe('Resend in 0:07');
    expect(resendIn(6_001)).toBe('Resend in 0:07');
    expect(resendIn(30_000)).toBe('Resend in 0:30');
    expect(resendIn(OTP_RULES.windowMs)).toBe('Resend in 10:00');
    expect(resendIn(61_500)).toBe('Resend in 1:02');
    expect(resendIn(0)).toBe('Resend in 0:00');
    expect(resendIn(-5)).toBe('Resend in 0:00');
    expect(resendIn(Number.NaN)).toBe('Resend in 0:00');
  });
});
