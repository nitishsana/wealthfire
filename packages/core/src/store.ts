// Storage-agnostic load/save. Web passes localStorage; mobile passes AsyncStorage.
import type {
  AppData, DocReaderId, KycField, KycMatch, KycState, KycStatus, OnboardingState, OnboardingStep, OtpProviderId, ReviewRecord,
} from './types';
import { DEFAULT_ASSUMPTIONS } from './fire';
// Circular with onboarding.ts, safe: both sides only call each other inside functions.
import {
  normalizeEmail, normalizeMobile, normalizePan, validateEmail, validateMobile, validateName, validatePan,
} from './onboarding';

export const STORAGE_KEY = 'wealthfire.data.v1';

/** Onboarding not started: the app opens on sign-in. */
export function emptyOnboarding(): OnboardingState {
  return {
    step: 'signin',
    contact: null,
    identity: null,
    aadhaar: null,
    completedAt: null,
    sends: { contact: [], aadhaar: [] },
    aadhaarLockedUntil: null,
    kyc: emptyKyc(),
  };
}

/** No document check done yet. */
export function emptyKyc(): KycState {
  return {
    match: null, status: null, reader: null, rereads: { pan: 0, aadhaar: 0 }, failedReads: { pan: 0, aadhaar: 0 },
    review: null, documentsAt: null, returnedFromCheck: false,
  };
}

/** Options for sanitizeOnboarding / deserialize. */
export interface SanitizeOptions {
  /**
   * true (default): this is a fresh app load, so the "after a reload" rules run (a stored
   * Check numbers step opens on Upload documents, returnedFromCheck is cleared).
   * false: e.g. a cross-tab storage update; only the safety rules run.
   */
  reload?: boolean;
}

const STEPS: readonly OnboardingStep[] = ['signin', 'otp', 'identity', 'aadhaar-otp', 'documents', 'check', 'done'];
const PROVIDERS: readonly OtpProviderId[] = ['demo', 'digilocker', 'digio'];
const READERS: readonly DocReaderId[] = ['ondevice', 'demo', 'digio', 'hyperverge'];
const MATCHES: readonly KycMatch[] = ['matched', 'review'];
const STATUSES: readonly KycStatus[] = ['pre-verified', 'verified', 'under-review', 'rejected'];

const isStr = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const pick = <T extends string>(list: readonly T[], v: unknown): T | null => (list.includes(v as T) ? (v as T) : null);
const clampCount = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0);
const rereadCount = (v: unknown): number => clampCount(v, 2);
/** Stored failed-read counts are kept within 0..9. */
export const MAX_FAILED_READS = 9;

/** A stored mask: masked shape only, and never a run of 5+ digits (so never a full Aadhaar). */
/** readMasked of a hand-check review row: the card couldn't be read. */
export const UNREADABLE_MASK = 'unreadable';

export function isSafeMask(s: unknown): s is string {
  return isStr(s) && /^[A-Z0-9X* ]{4,14}$/.test(s) && !/\d{5,}/.test(s);
}

function sanitizeReview(raw: unknown): ReviewRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.id) || !isStr(r.sentAt)) return null;
  const fields = (Array.isArray(r.fields) ? r.fields : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .filter((f) => (f.field === 'pan' || f.field === 'aadhaar') && isSafeMask(f.typedMasked) &&
      (f.handCheck === true ? f.readMasked === UNREADABLE_MASK : isSafeMask(f.readMasked)))
    .map((f) => ({
      field: f.field as KycField, typedMasked: f.typedMasked as string, readMasked: f.readMasked as string,
      ...(f.nameMismatch === true ? { nameMismatch: true as const } : {}),
      ...(f.nameNotChecked === true ? { nameNotChecked: true as const } : {}),
      ...(f.handCheck === true ? { handCheck: true as const } : {}),
    }));
  const d = r.decision as Record<string, unknown> | null | undefined;
  let decision: ReviewRecord['decision'] = null;
  if (d && typeof d === 'object' && (d.result === 'approved' || d.result === 'rejected') && isStr(d.at)) {
    decision = { result: d.result, reason: isStr(d.reason) ? d.reason.slice(0, 200) : null, at: d.at };
  }
  return { id: r.id, sentAt: r.sentAt, fields, decision };
}

function sanitizeKyc(raw: unknown): KycState {
  const out = emptyKyc();
  if (!raw || typeof raw !== 'object') return out;
  const k = raw as Record<string, unknown>;
  const rr = (k.rereads && typeof k.rereads === 'object' ? k.rereads : {}) as Record<string, unknown>;
  const fr = (k.failedReads && typeof k.failedReads === 'object' ? k.failedReads : {}) as Record<string, unknown>;
  const review = sanitizeReview(k.review);
  let status = pick(STATUSES, k.status);
  // Only a final KYC approval gives 'verified': stored 'verified' without an approved review
  // decision (old data from before pre-verified, or a hand edit) is lowered to 'pre-verified'.
  if (status === 'verified' && review?.decision?.result !== 'approved') status = 'pre-verified';
  return {
    match: pick(MATCHES, k.match),
    status,
    reader: pick(READERS, k.reader),
    rereads: { pan: rereadCount(rr.pan), aadhaar: rereadCount(rr.aadhaar) },
    failedReads: { pan: clampCount(fr.pan, MAX_FAILED_READS), aadhaar: clampCount(fr.aadhaar, MAX_FAILED_READS) },
    review,
    documentsAt: isStr(k.documentsAt) ? k.documentsAt : null,
    returnedFromCheck: k.returnedFromCheck === true,
  };
}

/**
 * Clean stored onboarding state. Keeps known keys only, never keeps more than 4 Aadhaar
 * digits, drops contact/identity values that fail validation, and moves the step back to
 * the furthest step whose data is really there. This stops old or corrupted data from
 * skipping a step. It is not a security boundary: storage is client-side, so a deliberate
 * hand edit can still mark Aadhaar as verified. A real provider must verify server-side.
 */
export function sanitizeOnboarding(raw: unknown, opts?: SanitizeOptions): OnboardingState {
  const reload = opts?.reload !== false;
  const out = emptyOnboarding();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  const c = r.contact as Record<string, unknown> | null | undefined;
  if (c && typeof c === 'object' && isStr(c.value)) {
    const verifiedAt = isStr(c.verifiedAt) ? c.verifiedAt : null;
    if (c.kind === 'email' && !validateEmail(c.value)) {
      out.contact = { kind: 'email', value: normalizeEmail(c.value), verifiedAt };
    } else if (c.kind === 'mobile' && !validateMobile(c.value)) {
      out.contact = { kind: 'mobile', value: normalizeMobile(c.value), verifiedAt };
    }
  }
  const i = r.identity as Record<string, unknown> | null | undefined;
  if (
    i && typeof i === 'object' && isStr(i.firstName) && isStr(i.lastName) && isStr(i.pan) &&
    !validateName(i.firstName) && !validateName(i.lastName) && !validatePan(i.pan)
  ) {
    out.identity = { firstName: i.firstName.trim(), lastName: i.lastName.trim(), pan: normalizePan(i.pan) };
  }
  const a = r.aadhaar as Record<string, unknown> | null | undefined;
  if (
    a && typeof a === 'object' &&
    isStr(a.last4) && /^\d{4}$/.test(a.last4) &&
    isStr(a.verifiedAt) &&
    PROVIDERS.includes(a.provider as OtpProviderId)
  ) {
    out.aadhaar = { last4: a.last4, verifiedAt: a.verifiedAt, provider: a.provider as OtpProviderId };
  }
  const s = r.sends as Record<string, unknown> | null | undefined;
  if (s && typeof s === 'object') out.sends = { contact: strList(s.contact), aadhaar: strList(s.aadhaar) };
  out.aadhaarLockedUntil = isStr(r.aadhaarLockedUntil) ? r.aadhaarLockedUntil : null;

  out.kyc = sanitizeKyc(r.kyc);

  // After a reload: never leave a field blocked without an earlier read on screen (the reads were
  // in memory only). Re-read counts are kept; Back within one session still counts.
  // Not on a cross-tab update (reload false): that would let a second tab reset the flag.
  if (reload) out.kyc.returnedFromCheck = false;

  // Furthest step the stored data supports. Steps past aadhaar-otp need the Aadhaar OTP;
  // done needs kyc.match and kyc.status.
  const verified = !!out.contact?.verifiedAt;
  const maxStep: OnboardingStep =
    !out.contact ? 'signin'
    : !verified ? 'otp'
    : !out.identity ? 'identity'
    : !out.aadhaar ? 'aadhaar-otp'
    : !out.kyc.match || !out.kyc.status ? 'check'
    : 'done';
  let want = STEPS.includes(r.step as OnboardingStep) ? (r.step as OnboardingStep) : 'signin';
  // Check numbers shows reads held in memory only, so after a reload it opens on Upload documents.
  // A cross-tab update (reload false) keeps a stored 'check' when the data supports it.
  if (want === 'check' && reload) want = 'documents';
  const clamped = STEPS.indexOf(want) > STEPS.indexOf(maxStep);
  out.step = clamped ? maxStep : want;
  // Safety: a step moved back to Check numbers (data missing for a later step) never opens there.
  // Check numbers also needs the documents to have been added.
  if (out.step === 'check' && (reload || clamped || !out.kyc.documentsAt)) out.step = 'documents';
  out.completedAt = out.step === 'done' && isStr(r.completedAt) ? r.completedAt : null;
  if (out.step === 'done' && !out.completedAt) out.completedAt = out.aadhaar?.verifiedAt ?? null;
  return out;
}

export function emptyData(): AppData {
  return {
    version: 1,
    profile: null,
    riskAnswers: {},
    assets: [],
    liabilities: [],
    expenses: [],
    assumptions: { ...DEFAULT_ASSUMPTIONS },
    buckets: null,
    snapshots: [],
    gmailLastSync: null,
    onboarding: emptyOnboarding(),
  };
}

/** Add Gmail expenses, skipping ids already stored. */
export function mergeExpenses(data: AppData, incoming: AppData['expenses']): AppData {
  const have = new Set(data.expenses.map((e) => e.id));
  return { ...data, expenses: [...data.expenses, ...incoming.filter((e) => !have.has(e.id))] };
}

/** Parse stored JSON safely. Bad or old data falls back to defaults field by field. */
export function deserialize(json: string | null | undefined, opts?: SanitizeOptions): AppData {
  const base = emptyData();
  if (!json) return base;
  try {
    const raw = JSON.parse(json) as Partial<AppData>;
    if (!raw || typeof raw !== 'object') return base;
    return {
      version: 1,
      profile: raw.profile ?? null,
      riskAnswers: raw.riskAnswers && typeof raw.riskAnswers === 'object' ? raw.riskAnswers : {},
      assets: Array.isArray(raw.assets) ? raw.assets : [],
      liabilities: Array.isArray(raw.liabilities) ? raw.liabilities : [],
      expenses: Array.isArray(raw.expenses) ? raw.expenses : [],
      assumptions: { ...DEFAULT_ASSUMPTIONS, ...(raw.assumptions ?? {}) },
      buckets: raw.buckets ?? null,
      snapshots: Array.isArray(raw.snapshots) ? raw.snapshots : [],
      gmailLastSync: typeof raw.gmailLastSync === 'string' ? raw.gmailLastSync : null,
      onboarding: sanitizeOnboarding(raw.onboarding, opts),
    };
  } catch {
    return base;
  }
}

export function serialize(data: AppData): string {
  return JSON.stringify(data);
}
