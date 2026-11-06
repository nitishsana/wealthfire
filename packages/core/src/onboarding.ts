// Onboarding rules: validators, masks, OTP limits and the step reducer.
// Pure functions only; time is always passed in. Never store or log a full Aadhaar or an OTP.
import type {
  AppData, ContactKind, DocReaderId, KycField, KycMatch, OnboardingState, OtpProviderId, ReviewRecord,
} from './types';
// Circular imports (store, kyc) are safe: they are only used inside functions.
import { emptyKyc, emptyOnboarding, isSafeMask } from './store';
import { MAX_REREADS } from './kyc';

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
  | { type: 'identity-saved'; firstName: string; lastName: string; pan: string }
  | { type: 'back-to-identity' }
  | { type: 'aadhaar-verified'; last4: string; at: string; provider: OtpProviderId }
  | { type: 'aadhaar-locked'; until: string }
  | { type: 'sign-out' }
  | { type: 'documents-ready'; at: string; reader: DocReaderId }
  | { type: 'back-to-documents' }
  | { type: 'reread-used'; field: KycField }
  | { type: 'check-confirmed'; match: KycMatch; pan: string; fields: ReviewRecord['fields']; at: string }
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

function addSend(list: string[], at: string): string[] {
  const t = Date.parse(at);
  return [...(Number.isFinite(t) ? pruneSends(list, t) : list), at];
}

function normalizeContact(c: { kind: ContactKind; value: string }): { kind: ContactKind; value: string } | null {
  if (c.kind === 'email') return validateEmail(c.value) ? null : { kind: 'email', value: normalizeEmail(c.value) };
  return validateMobile(c.value) ? null : { kind: 'mobile', value: normalizeMobile(c.value) };
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
      return {
        ...s,
        step: 'otp',
        contact: same && keep ? keep : { ...target, verifiedAt: null },
        sends: { ...s.sends, contact: addSend(s.sends.contact, e.at) },
      };
    }
    case 'contact-verified':
      if (s.step !== 'otp' || !s.contact) return s;
      return { ...s, step: 'identity', contact: { ...s.contact, verifiedAt: e.at } };
    case 'change-contact':
      if (s.step !== 'otp') return s;
      return { ...s, step: 'signin', contact: null };
    case 'identity-saved': {
      if (s.step !== 'identity') return s;
      if (validateName(e.firstName) || validateName(e.lastName) || validatePan(e.pan)) return s;
      return {
        ...s,
        step: 'aadhaar-otp',
        identity: { firstName: e.firstName.trim(), lastName: e.lastName.trim(), pan: normalizePan(e.pan) },
      };
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
      const rereads = s.kyc.returnedFromCheck
        ? {
          pan: Math.min(MAX_REREADS, s.kyc.rereads.pan + 1),
          aadhaar: Math.min(MAX_REREADS, s.kyc.rereads.aadhaar + 1),
        }
        : s.kyc.rereads;
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
          // On 'matched', a decided review from an earlier round stays as history.
          review: e.match === 'review'
            ? { id, sentAt: e.at, fields: e.fields.map((f) => ({ ...f })), decision: null }
            : s.kyc.review?.decision ? s.kyc.review : null,
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
