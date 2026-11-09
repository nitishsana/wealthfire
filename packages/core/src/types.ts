// Shared data model. Web, Android and iOS all store and read these shapes,
// so a change here is a change on every platform.

export type FireTypeId = 'lean' | 'regular' | 'barista' | 'fat';

export interface Profile {
  name: string;
  age: number;
  city: string;
  monthlyIncome: number; // take-home, INR
  dependents: number;
  targetRetireAge: number;
  lifeExpectancy: number;
  /** Current monthly SIP already running, INR */
  currentMonthlySip: number;
  /** Optional manual override of monthly expenses; else derived from expenses */
  monthlyExpenseOverride?: number;
  /** Which FIRE the user is aiming for. Default 'regular'. */
  fireType?: FireTypeId;
  /** Barista FIRE: monthly part-time income after quitting full-time work, today's rupees */
  partTimeIncome?: number;
}

export type AssetType =
  | 'equity_mf'
  | 'debt_mf'
  | 'stocks'
  | 'fd'
  | 'epf'
  | 'ppf'
  | 'nps'
  | 'gold'
  | 'cash'
  | 'real_estate'
  | 'other';

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  value: number;
  /** Where it came from: typed in, or linked app (future) */
  source: 'manual' | 'linked' | 'demo';
}

export type LiabilityType = 'home_loan' | 'car_loan' | 'personal_loan' | 'credit_card' | 'education_loan' | 'other';

export interface Liability {
  id: string;
  name: string;
  type: LiabilityType;
  outstanding: number;
  monthlyEmi: number;
  interestRate: number; // % per year
}

export type ExpenseCategory =
  | 'Food'
  | 'Groceries'
  | 'Shopping'
  | 'Transport'
  | 'Fuel'
  | 'Bills'
  | 'Entertainment'
  | 'Travel'
  | 'Health'
  | 'Education'
  | 'Rent'
  | 'EMI'
  | 'Other';

export interface Expense {
  id: string;
  date: string; // ISO yyyy-mm-dd
  description: string;
  amount: number; // positive = spend
  category: ExpenseCategory;
  source: 'manual' | 'statement' | 'gmail' | 'demo';
}

export type RiskProfileName = 'Conservative' | 'Moderate' | 'Balanced' | 'Growth' | 'Aggressive';

export interface RiskResult {
  score: number; // 0-100
  profile: RiskProfileName;
}

export interface Assumptions {
  inflation: number; // % per year
  equityReturn: number; // % per year
  debtReturn: number; // % per year
  cashReturn: number; // % per year
  safeWithdrawalRate: number; // % per year
  sipStepUp: number; // % yearly increase of SIP
  /** Equity market return over the last 12 months, %. Drives bucket refill tips. */
  lastYearEquityReturn: number;
}

export interface BucketState {
  bucket1: number; // cash / liquid
  bucket2: number; // debt / hybrid
  bucket3: number; // equity
}

export interface Snapshot {
  date: string; // ISO yyyy-mm-dd
  investable: number;
  netWorth: number;
  fireNumber: number;
  monthlySip: number;
}

export type OnboardingStep = 'signin' | 'otp' | 'identity' | 'aadhaar-otp' | 'documents' | 'check' | 'done';
export type ContactKind = 'email' | 'mobile';
/** 'http' = contact OTP through the Wealthfire KYC server (HttpOtpProvider). */
export type OtpProviderId = 'demo' | 'digilocker' | 'digio' | 'http';

export type KycField = 'pan' | 'aadhaar';
export type KycMatch = 'matched' | 'review';
/**
 * 'pre-verified': the device checks passed (numbers and names match). Not eligible to invest:
 * only a final KYC confirmation (KYC partner / KRA-CKYC, or a review approval) sets 'verified'.
 */
export type KycStatus = 'pre-verified' | 'verified' | 'under-review' | 'rejected';
export type DocReaderId = 'ondevice' | 'demo' | 'digio' | 'hyperverge';

/** A manual review of numbers that did not match their documents. Masks only, never a full Aadhaar. */
export interface ReviewRecord {
  /** 'rv_' + time in ms, base 36 (no long digit runs in storage) */
  id: string;
  /** ISO, set on Check numbers → Confirm */
  sentAt: string;
  /** `nameMismatch`: the name on that card didn't match the name the user entered. */
  /** `nameNotChecked`: the name couldn't be checked (e.g. typed in an Indian script), so a person checks it. */
  /** `handCheck`: the card couldn't be read (readMasked is 'unreadable'); the team checks the documents by hand. */
  fields: { field: KycField; typedMasked: string; readMasked: string; nameMismatch?: true; nameNotChecked?: true; handCheck?: true }[];
  decision: { result: 'approved' | 'rejected'; reason: string | null; at: string } | null;
}

export interface KycState {
  /** set on Check numbers → Confirm */
  match: KycMatch | null;
  /** set on Check numbers → Confirm; changed by a review decision */
  status: KycStatus | null;
  reader: DocReaderId | null;
  /** max 2 each */
  rereads: { pan: number; aadhaar: number };
  /**
   * Failed reads per card (0..9). At 2 or more (or once the reader is unavailable) the user may
   * send the documents for a hand check (canSendForHandCheck). Reset by a successful Check numbers → Confirm.
   */
  failedReads: { pan: number; aadhaar: number };
  review: ReviewRecord | null;
  /** time all 3 documents were added (the files themselves are never stored) */
  documentsAt: string | null;
  /** true after Back from Check numbers; the next read of the documents counts as a re-read. Cleared on reload. */
  returnedFromCheck: boolean;
}

/** Saved onboarding progress. OTP codes and the full Aadhaar number are never part of it. */
export interface OnboardingState {
  step: OnboardingStep;
  /** value: lower-cased email or 10 digits */
  contact: { kind: ContactKind; value: string; verifiedAt: string | null } | null;
  /** dob: ISO yyyy-mm-dd, 18+. Missing for users who onboarded before DOB was asked (see needsDob). */
  identity: { firstName: string; lastName: string; pan: string; dob?: string } | null;
  /** Only the last 4 digits are ever stored. */
  aadhaar: { last4: string; verifiedAt: string; provider: OtpProviderId } | null;
  completedAt: string | null;
  /** Send times (ISO) per channel in the last 10 minutes, for the resend limit. */
  sends: { contact: string[]; aadhaar: string[] };
  /** Aadhaar step lockout. Persisted so a restart does not bypass it. */
  aadhaarLockedUntil: string | null;
  /** Document check and review state (Part B). */
  kyc: KycState;
}

/** Everything a user owns in the app. Stored on device only in v1. */
export interface AppData {
  version: 1;
  profile: Profile | null;
  riskAnswers: Record<string, number>;
  assets: Asset[];
  liabilities: Liability[];
  expenses: Expense[];
  assumptions: Assumptions;
  buckets: BucketState | null;
  snapshots: Snapshot[];
  /** Last successful Gmail sync, ISO date-time. The token itself is never stored. */
  gmailLastSync: string | null;
  /** Sign-in and identity check progress. */
  onboarding: OnboardingState;
}
