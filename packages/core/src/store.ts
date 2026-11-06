// Storage-agnostic load/save. Web passes localStorage; mobile passes AsyncStorage.
import type { AppData, OnboardingState, OnboardingStep, OtpProviderId } from './types';
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
  };
}

const STEPS: readonly OnboardingStep[] = ['signin', 'otp', 'identity', 'aadhaar-otp', 'done'];
const PROVIDERS: readonly OtpProviderId[] = ['demo', 'digilocker', 'digio'];

const isStr = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

/**
 * Clean stored onboarding state. Keeps known keys only, never keeps more than 4 Aadhaar
 * digits, drops contact/identity values that fail validation, and moves the step back to
 * the furthest step whose data is really there. This stops old or corrupted data from
 * skipping a step. It is not a security boundary: storage is client-side, so a deliberate
 * hand edit can still mark Aadhaar as verified. A real provider must verify server-side.
 */
export function sanitizeOnboarding(raw: unknown): OnboardingState {
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

  // Furthest step the stored data supports.
  const verified = !!out.contact?.verifiedAt;
  const maxStep: OnboardingStep =
    !out.contact ? 'signin'
    : !verified ? 'otp'
    : !out.identity ? 'identity'
    : !out.aadhaar ? 'aadhaar-otp'
    : 'done';
  const want = STEPS.includes(r.step as OnboardingStep) ? (r.step as OnboardingStep) : 'signin';
  out.step = STEPS.indexOf(want) <= STEPS.indexOf(maxStep) ? want : maxStep;
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
export function deserialize(json: string | null | undefined): AppData {
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
      onboarding: sanitizeOnboarding(raw.onboarding),
    };
  } catch {
    return base;
  }
}

export function serialize(data: AppData): string {
  return JSON.stringify(data);
}
