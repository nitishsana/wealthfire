// Onboarding rules: validators, masks, OTP limits and the step reducer.
// Pure functions only; time is always passed in. Never store or log a full Aadhaar or an OTP.
import type {
  AppData, ContactKind, DocReaderId, KycField, KycMatch, OnboardingState, OtpProviderId, ReviewRecord,
} from './types';
// Circular imports (store, kyc) are safe: they are only used inside functions.
import { emptyKyc, emptyOnboarding, isSafeMask, MAX_FAILED_READS, NOT_READ_MASK, UNREADABLE_MASK } from './store';
import { canSendForHandCheck, HAND_CHECK_AFTER_FAILS, MAX_REREADS } from './kyc';

// ---------- Validators (return error text, or null when OK) ----------

export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export function validateEmail(s: string): string | null {
  const v = normalizeEmail(s);
  return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'Enter a valid email address.';
}

export function normalizeMobile(s: string): string {
  const v = s.replace(/[\s-]/g, '');
  if (v.startsWith('+91')) return v.slice(3);
  if (v.startsWith('0')) return v.slice(1);
  return v;
}

export function validateMobile(s: string): string | null {
  return /^[6-9]\d{9}$/.test(normalizeMobile(s)) ? null : 'Enter a valid 10-digit mobile number.';
}

export function validateName(s: string): string | null {
  // \p{M} (combining marks) is needed for Indic scripts, e.g. the vowel signs in नितीश.
  return /^[\p{L}][\p{L}\p{M} .'-]{0,49}$/u.test(s.trim()) ? null : 'Use 1–50 letters.';
}

export function normalizePan(s: string): string {
  return s.trim().toUpperCase();
}

export function validatePan(s: string): string | null {
  const v = normalizePan(s);
  if (!/^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(v)) return 'Enter a valid PAN, like ABCPE1234F.';
  if (v[3] !== 'P') return 'This looks like a non-individual PAN. Use your personal PAN.';
  return null;
}

/** Soft warning only: Continue stays allowed. */
export function panSurnameWarning(pan: string, lastName: string): string | null {
  const p = normalizePan(pan);
  const first = lastName.trim().charAt(0).toUpperCase();
  if (p.length < 5 || !first) return null;
  return p[4] === first ? null : "PAN's 5th letter usually matches your last name";
}

export const DOB_LABEL = 'Date of birth';
export const DOB_HINT = 'DD/MM/YYYY';
/** Investors must be at least this old. */
export const MIN_INVEST_AGE = 18;
export const MAX_DOB_AGE = 120;

export const DOB_MESSAGES = {
  format: 'Enter your date of birth as DD/MM/YYYY.',
  minor: 'You must be 18 or older to invest.',
  unreal: 'Enter a real date of birth.',
} as const;

/** Identity exists but has no date of birth: ask for it (dispatch 'dob-added') before server KYC starts. */
export function needsDob(s: OnboardingState | null | undefined): boolean {
  return !!s?.identity && !s.identity.dob;
}

/** dd/mm/yyyy or yyyy-mm-dd → [y, m, d]; null when the shape is wrong. */
function dobParts(input: string): [number, number, number] | null {
  const v = input.trim();
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (dmy) return [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])];
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (ymd) return [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  return null;
}

function isCalendarDate(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** Date of birth as ISO yyyy-mm-dd (from dd/mm/yyyy or yyyy-mm-dd); '' when it isn't a calendar date. */
export function normalizeDob(input: string): string {
  const p = dobParts(input);
  if (!p || !isCalendarDate(...p)) return '';
  const [y, m, d] = p;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Whole years from a birth date to `today` (local calendar date). A 29 Feb birthday counts from 1 Mar. */
export function ageOn(dobIso: string, today: Date = new Date()): number {
  const [y, m, d] = dobIso.split('-').map(Number) as [number, number, number];
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  const td = today.getDate();
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/**
 * Date of birth check (dd/mm/yyyy or yyyy-mm-dd). Error text, or null when OK.
 * Not a calendar date, in the future or over 120 years → 'Enter a real date of birth.'; under 18 → minor.
 */
export function validateDob(input: string, today: Date = new Date()): string | null {
  if (typeof input !== 'string' || !dobParts(input)) return DOB_MESSAGES.format;
  const iso = normalizeDob(input);
  if (!iso) return DOB_MESSAGES.unreal;
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  if (iso > todayIso) return DOB_MESSAGES.unreal;
  const age = ageOn(iso, today);
  if (age > MAX_DOB_AGE) return DOB_MESSAGES.unreal;
  if (age < MIN_INVEST_AGE) return DOB_MESSAGES.minor;
  return null;
}

export function normalizeAadhaar(s: string): string {
  return s.replace(/\D/g, '');
}

export function validateAadhaar(s: string): string | null {
  const v = normalizeAadhaar(s);
  return /^[2-9]\d{11}$/.test(v) && verhoeffValid(v) ? null : 'Enter a valid 12-digit Aadhaar number.';
}

/**
 * "Enter your Aadhaar number again" on Upload documents (after a reload or Redo documents).
 * The number must be valid and end in the OTP-verified last 4. Null when OK.
 */
export function confirmAadhaarRetype(full: string, verifiedLast4: string): string | null {
  const bad = validateAadhaar(full);
  if (bad) return bad;
  return normalizeAadhaar(full).slice(-4) === verifiedLast4 ? null : "This doesn't match the Aadhaar you verified.";
}

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff checksum over a digit string (check digit last). */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    c = VD[c]![VP[i % 8]![Number(rev[i])]!]!;
  }
  return c === 0;
}

const VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Verhoeff check digit for a digit string, e.g. '23412341234' → '6'. Throws on non-digits. */
export function verhoeffCheckDigit(first11: string): string {
  if (!/^\d+$/.test(first11)) throw new Error('verhoeffCheckDigit needs digits only');
  let c = 0;
  const rev = first11.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    c = VD[c]![VP[(i + 1) % 8]![Number(rev[i])]!]!;
  }
  return String(VINV[c]);
}

// ---------- Display helpers ----------

/** 'nitish@gmail.com' → 'n*****@gmail.com' */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return email;
  return email[0] + '*'.repeat(at - 1) + email.slice(at);
}

/** '9876543210' → '+91 ******3210' */
export function maskMobile(mobile: string): string {
  const v = normalizeMobile(mobile);
  return `+91 ${'*'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}

/** 'ABCPE1234F' → 'ABCPE****F' */
export function maskPan(pan: string): string {
  const v = normalizePan(pan);
  if (v.length !== 10) return v;
  return `${v.slice(0, 5)}****${v.slice(9)}`;
}

/** '1234' (last 4 digits) → 'XXXX XXXX 1234' */
export function maskAadhaar(last4: string): string {
  return `XXXX XXXX ${last4}`;
}

/** '234123412346' → '2341 2341 2346'. Works on partial input too. */
export function groupAadhaar(s: string): string {
  return (normalizeAadhaar(s).slice(0, 12).match(/.{1,4}/g) ?? []).join(' ');
}

// ---------- OTP limits ----------

export const OTP_RULES = {
  length: 6,
  expiryMs: 5 * 60_000,
  maxTries: 5,
  resendCooldownMs: 30_000,
  maxSendsPerWindow: 4 /* 1 send + 3 resends */,
  windowMs: 10 * 60_000,
  aadhaarLockMs: 30 * 60_000,
} as const;

export type CanSendResult = { ok: true } | { ok: false; waitMs: number; reason: 'cooldown' | 'limit' | 'locked' };

/** Keep only send times from the last 10 minutes. */
export function pruneSends(sends: string[], now: number): string[] {
  return sends.filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && now - t < OTP_RULES.windowMs;
  });
}

/** May a new OTP be sent now? Checks lockout, then the 10-minute limit, then the 30-second cooldown. */
export function canSend(sends: string[], now: number, lockedUntil?: string | null): CanSendResult {
  const lock = lockedUntil ? Date.parse(lockedUntil) : NaN;
  if (Number.isFinite(lock) && now < lock) return { ok: false, waitMs: lock - now, reason: 'locked' };
  const times = pruneSends(sends, now).map((s) => Date.parse(s)).sort((a, b) => a - b);
  if (times.length >= OTP_RULES.maxSendsPerWindow) {
    return { ok: false, waitMs: times[0]! + OTP_RULES.windowMs - now, reason: 'limit' };
  }
  const last = times[times.length - 1];
  if (last !== undefined && now - last < OTP_RULES.resendCooldownMs) {
    return { ok: false, waitMs: last + OTP_RULES.resendCooldownMs - now, reason: 'cooldown' };
  }
  return { ok: true };
}

/** Cooldown button label from a wait in ms, rounded up to whole seconds: 7000 → 'Resend in 0:07'. */
export function resendIn(ms: number): string {
  const total = Number.isFinite(ms) ? Math.ceil(Math.max(0, ms) / 1000) : 0;
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `Resend in ${m}:${String(sec).padStart(2, '0')}`;
}

// ---------- Step reducer ----------

export type OnboardingEvent =
  | { type: 'otp-sent'; channel: 'contact' | 'aadhaar'; at: string; contact?: { kind: ContactKind; value: string } }
  | { type: 'contact-verified'; at: string }
  | { type: 'change-contact' }
  /** `dob`: dd/mm/yyyy or yyyy-mm-dd (stored ISO). `at`: ISO time of the save, for the 18+ check (default now). */
  | { type: 'identity-saved'; firstName: string; lastName: string; pan: string; dob: string; at?: string }
  /** Add / replace the date of birth from any step with an identity (validated 18+; stored ISO). `at` as in identity-saved. */
  | { type: 'dob-added'; dob: string; at?: string }
  | { type: 'back-to-identity' }
  | { type: 'aadhaar-verified'; last4: string; at: string; provider: OtpProviderId }
  | { type: 'aadhaar-locked'; until: string }
  | { type: 'sign-out' }
  /**
   * `reread`: after Back from Check numbers, the cards really read again (a replaced document). A card
   * whose earlier check is kept (same document) is not counted. Default: both cards.
   */
  | { type: 'documents-ready'; at: string; reader: DocReaderId; reread?: KycField[] }
  /** A card was read well: earlier failed tries of that card (e.g. a locked PDF before its password) no longer count. */
  | { type: 'read-ok'; field: KycField }
  | { type: 'back-to-documents' }
  | { type: 'reread-used'; field: KycField }
  | { type: 'check-confirmed'; match: KycMatch; pan: string; fields: ReviewRecord['fields']; at: string }
  /** A card could not be read (+1), or the reader isn't available in this build (unavailable: set to 2). */
  | { type: 'read-failed'; field: KycField; unavailable?: boolean }
  /** Hand-check fallback: send the documents to the team (only when canSendForHandCheck). */
  /**
   * `reads`: the last successful read value per card (full numbers, screen state). The reducer
   * keeps ONLY their masks, and only for a card that is not itself being sent as unreadable.
   */
  | { type: 'send-for-hand-check'; at: string; reads?: Partial<Record<KycField, string>> }
  | { type: 'review-decided'; result: 'approved' | 'rejected'; reason: string | null; at: string }
  | { type: 'redo-documents' };

/**
 * Review record id from an ISO time: 'rv_' + ms in base 36, not decimal (a 13-digit ms run would
 * break the "no 12-digit run in storage" check). null when the time doesn't parse.
 */
function reviewId(at: string): string | null {
  const t = Date.parse(at);
  return Number.isFinite(t) ? `rv_${t.toString(36)}` : null;
}

/** Mask of a read value for a review row; NOT_READ_MASK when missing or not a valid-shaped number. */
function readMask(field: KycField, v: unknown): string {
  if (typeof v !== 'string') return NOT_READ_MASK;
  let m: string | null = null;
  if (field === 'pan') {
    const p = normalizePan(v);
    m = /^[A-Z]{5}\d{4}[A-Z]$/.test(p) ? maskPan(p) : null;
  } else {
    const a = normalizeAadhaar(v);
    m = /^\d{12}$/.test(a) ? maskAadhaar(a.slice(-4)) : null;
  }
  return m && isSafeMask(m) ? m : NOT_READ_MASK;
}

function addSend(list: string[], at: string): string[] {
  const t = Date.parse(at);
  return [...(Number.isFinite(t) ? pruneSends(list, t) : list), at];
}

function normalizeContact(c: { kind: ContactKind; value: string }): { kind: ContactKind; value: string } | null {
  if (c.kind === 'email') return validateEmail(c.value) ? null : { kind: 'email', value: normalizeEmail(c.value) };
  return validateMobile(c.value) ? null : { kind: 'mobile', value: normalizeMobile(c.value) };
}

const sameContact = (a: { kind: ContactKind; value: string }, b: { kind: ContactKind; value: string }) => a.kind === b.kind && a.value === b.value;

/** Sign in after Sign out: 'Sign in with +91 ******3210 to open your planner again.', or '' when nothing is kept. */
export function signedOutHint(s: OnboardingState): string {
  if (!s.signedOut || s.step !== 'signin') return '';
  const c = s.signedOut;
  return `Sign in with ${c.kind === 'email' ? maskEmail(c.value) : maskMobile(c.value)} to open your planner again.`;
}

/** Move onboarding forward. Events from the wrong step return the state unchanged. */
export function onboardingReducer(s: OnboardingState, e: OnboardingEvent): OnboardingState {
  switch (e.type) {
    case 'otp-sent': {
      if (e.channel === 'aadhaar') {
        if (s.step !== 'aadhaar-otp') return s;
        return { ...s, sends: { ...s.sends, aadhaar: addSend(s.sends.aadhaar, e.at) } };
      }
      if (s.step !== 'signin' && s.step !== 'otp') return s;
      const next = e.contact ? normalizeContact(e.contact) : null;
      if (e.contact && !next) return s;
      const keep = s.step === 'otp' ? s.contact : null;
      const target = next ?? keep;
      if (!target) return s;
      const same = keep && keep.kind === target.kind && keep.value === target.value;
      // After Sign out: another contact is another person, so the kept onboarding goes (send limits stay).
      const base = s.signedOut && !sameContact(s.signedOut, target) ? { ...emptyOnboarding(), sends: s.sends } : s;
      return {
        ...base,
        step: 'otp',
        contact: same && keep ? keep : { ...target, verifiedAt: null },
        sends: { ...s.sends, contact: addSend(s.sends.contact, e.at) },
      };
    }
    case 'contact-verified':
      if (s.step !== 'otp' || !s.contact) return s;
      // Signed in again with the contact the onboarding was finished with: straight back to the planner.
      if (s.signedOut && sameContact(s.signedOut, s.contact) && s.identity && s.aadhaar && s.kyc.match && s.kyc.status) {
        return { ...s, step: 'done', contact: { ...s.contact, verifiedAt: e.at }, completedAt: s.signedOut.completedAt, signedOut: null };
      }
      return { ...s, step: 'identity', contact: { ...s.contact, verifiedAt: e.at } };
    case 'change-contact':
      if (s.step !== 'otp') return s;
      return { ...s, step: 'signin', contact: null };
    case 'identity-saved': {
      if (s.step !== 'identity') return s;
      const t = e.at ? Date.parse(e.at) : NaN;
      const today = Number.isFinite(t) ? new Date(t) : new Date();
      if (validateName(e.firstName) || validateName(e.lastName) || validatePan(e.pan) || validateDob(e.dob, today)) return s;
      return {
        ...s,
        step: 'aadhaar-otp',
        identity: { firstName: e.firstName.trim(), lastName: e.lastName.trim(), pan: normalizePan(e.pan), dob: normalizeDob(e.dob) },
      };
    }
    case 'dob-added': {
      // Any step with an identity (users who onboarded before DOB was asked). Step unchanged.
      if (!s.identity) return s;
      const t = e.at ? Date.parse(e.at) : NaN;
      if (validateDob(e.dob, Number.isFinite(t) ? new Date(t) : new Date())) return s;
      return { ...s, identity: { ...s.identity, dob: normalizeDob(e.dob) } };
    }
    case 'back-to-identity':
      // Only before the Aadhaar OTP passes. From documents / check the Aadhaar is locked.
      if (s.step !== 'aadhaar-otp') return s;
      return { ...s, step: 'identity' };
    case 'aadhaar-verified': {
      if (s.step !== 'aadhaar-otp' || !/^\d{4}$/.test(e.last4)) return s;
      return { ...s, step: 'documents', aadhaar: { last4: e.last4, verifiedAt: e.at, provider: e.provider } };
    }
    case 'documents-ready': {
      if (s.step !== 'documents' || !s.aadhaar) return s;
      // A read after Back from Check numbers is a re-read of every field (Bug 1: no bypass via Back).
      // TC-50: only a card actually read again counts; a kept earlier check (same document) does not.
      const again = (f: KycField) => s.kyc.returnedFromCheck && (e.reread ? e.reread.includes(f) : true);
      const rereads = {
        pan: again('pan') ? Math.min(MAX_REREADS, s.kyc.rereads.pan + 1) : s.kyc.rereads.pan,
        aadhaar: again('aadhaar') ? Math.min(MAX_REREADS, s.kyc.rereads.aadhaar + 1) : s.kyc.rereads.aadhaar,
      };
      return { ...s, step: 'check', kyc: { ...s.kyc, documentsAt: e.at, reader: e.reader, rereads, returnedFromCheck: false } };
    }
    case 'back-to-documents':
      if (s.step !== 'check') return s;
      return { ...s, step: 'documents', kyc: { ...s.kyc, returnedFromCheck: true } };
    case 'reread-used':
      if (s.step !== 'check') return s;
      return {
        ...s,
        kyc: { ...s.kyc, rereads: { ...s.kyc.rereads, [e.field]: Math.min(MAX_REREADS, s.kyc.rereads[e.field] + 1) } },
      };
    case 'check-confirmed': {
      if (s.step !== 'check' || !s.identity || !s.aadhaar || validatePan(e.pan)) return s;
      const id = reviewId(e.at);
      if (!id) return s;
      if (e.match === 'review') {
        if (e.fields.length === 0 || !e.fields.every((f) => isSafeMask(f.typedMasked) && isSafeMask(f.readMasked))) return s;
        // The Aadhaar is locked to the OTP-verified number: a review can only show that one as typed.
        const verified = maskAadhaar(s.aadhaar.last4);
        if (e.fields.some((f) => f.field === 'aadhaar' && f.typedMasked !== verified)) return s;
      }
      return {
        ...s,
        step: 'done',
        completedAt: e.at,
        identity: { ...s.identity, pan: normalizePan(e.pan) },
        kyc: {
          ...s.kyc,
          match: e.match,
          // The device checks never give 'verified': only a final KYC confirmation does (review-decided).
          status: e.match === 'matched' ? 'pre-verified' : 'under-review',
          returnedFromCheck: false,
          failedReads: { pan: 0, aadhaar: 0 },
          // On 'matched', a decided review from an earlier round stays as history.
          review: e.match === 'review'
            ? { id, sentAt: e.at, fields: e.fields.map((f) => ({ ...f })), decision: null }
            : s.kyc.review?.decision ? s.kyc.review : null,
        },
      };
    }
    case 'read-failed': {
      if (s.step !== 'documents' && s.step !== 'check') return s;
      if (e.field !== 'pan' && e.field !== 'aadhaar') return s;
      const now = s.kyc.failedReads[e.field];
      const next = e.unavailable ? Math.max(now, HAND_CHECK_AFTER_FAILS) : Math.min(MAX_FAILED_READS, now + 1);
      return { ...s, kyc: { ...s.kyc, failedReads: { ...s.kyc.failedReads, [e.field]: next } } };
    }
    case 'read-ok': {
      // TC-21: a good read of a card (e.g. the e-Aadhaar after its password) clears that card's failed tries.
      if (s.step !== 'documents' && s.step !== 'check') return s;
      if ((e.field !== 'pan' && e.field !== 'aadhaar') || s.kyc.failedReads[e.field] === 0) return s;
      return { ...s, kyc: { ...s.kyc, failedReads: { ...s.kyc.failedReads, [e.field]: 0 } } };
    }
    case 'send-for-hand-check': {
      if (s.step !== 'documents' && s.step !== 'check') return s;
      // The UI requires all three documents before offering this; no documentsAt needed.
      if (!canSendForHandCheck(s.kyc)) return s;
      if (!s.identity || !s.aadhaar) return s;
      const id = reviewId(e.at);
      if (!id) return s;
      const typed = { pan: maskPan(s.identity.pan), aadhaar: maskAadhaar(s.aadhaar.last4) };
      // Both cards are listed: a failed card as 'unreadable' (hand check), the other with the mask
      // of its last successful read, or 'not read'. Full read values are never stored.
      const fields: ReviewRecord['fields'] = (['pan', 'aadhaar'] as const).map((f) =>
        s.kyc.failedReads[f] >= HAND_CHECK_AFTER_FAILS
          ? { field: f, typedMasked: typed[f], readMasked: UNREADABLE_MASK, handCheck: true as const }
          : { field: f, typedMasked: typed[f], readMasked: readMask(f, e.reads?.[f]) });
      return {
        ...s,
        step: 'done',
        completedAt: e.at,
        kyc: {
          ...s.kyc,
          match: 'review',
          status: 'under-review',
          returnedFromCheck: false,
          documentsAt: s.kyc.documentsAt ?? e.at,
          review: { id, sentAt: e.at, fields, decision: null },
        },
      };
    }
    case 'aadhaar-locked':
      if (s.step !== 'aadhaar-otp') return s;
      return { ...s, aadhaarLockedUntil: e.until };
    case 'review-decided': {
      if (s.step !== 'done') return s;
      // Under review: decide the pending review. Pre-verified: the final KYC approval (no pending
      // review needed; a decided record is created). Rejecting a pre-verified account isn't possible.
      const pre = s.kyc.status === 'pre-verified';
      if (pre ? e.result !== 'approved' : s.kyc.status !== 'under-review' || !s.kyc.review) return s;
      const reason = e.reason?.trim() ?? '';
      if (e.result === 'rejected' && (reason.length < 1 || reason.length > 200)) return s;
      const decision = { result: e.result, reason: e.result === 'rejected' ? reason : null, at: e.at };
      let base: ReviewRecord;
      if (!pre && s.kyc.review) base = s.kyc.review;
      else {
        // Pre-verified: a new decided record (an earlier round's decided review is replaced, never re-decided).
        const id = reviewId(e.at);
        if (!id) return s;
        base = { id, sentAt: e.at, fields: [], decision: null };
      }
      return {
        ...s,
        kyc: { ...s.kyc, status: e.result === 'approved' ? 'verified' : 'rejected', review: { ...base, decision } },
      };
    }
    case 'redo-documents':
      if (s.step !== 'done' || s.kyc.status !== 'rejected') return s;
      // Back to Upload documents; the Aadhaar stays verified (no new OTP).
      // Previous review stays as history until a new one replaces it.
      return { ...s, step: 'documents', completedAt: null, kyc: { ...emptyKyc(), review: s.kyc.review } };
    case 'sign-out':
      // TC-37: Sign out ends the session only. A finished onboarding stays on the device for the same person.
      if (s.step === 'done' && s.contact) {
        return {
          ...s, step: 'signin', contact: null, completedAt: null,
          signedOut: { kind: s.contact.kind, value: s.contact.value, completedAt: s.completedAt ?? s.aadhaar?.verifiedAt ?? '' },
        };
      }
      // Signing out again before signing back in keeps the finished onboarding.
      if (s.signedOut) return { ...s, step: 'signin', contact: null };
      return emptyOnboarding();
    default:
      return s;
  }
}

/** Step to open on app start. The store already holds the first step not done. */
export function resumeStep(s: OnboardingState): OnboardingState['step'] {
  return s.step;
}

/**
 * Start value for the Profile name field: the saved name if there is one,
 * else "First Last" from onboarding, else ''.
 */
export function prefillProfileName(data: AppData): string {
  const name = data.profile?.name?.trim();
  if (name) return data.profile!.name;
  const id = data.onboarding?.identity;
  return id ? `${id.firstName} ${id.lastName}`.trim() : '';
}
