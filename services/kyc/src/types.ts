// Final KYC types (design §2, §5). Only masked values live here: never a full PAN, Aadhaar,
// OTP, token or document content.
import type { KycStatus as CoreKycStatus } from '@wealthfire/core';

/** Same four names the apps use (packages/core), so app and server never disagree. */
export type KycStatus = CoreKycStatus; // 'pre-verified' | 'under-review' | 'verified' | 'rejected'

/** How a case reached (or is heading to) its result. */
export type KycPath = 'kra-validated' | 'full-kyc' | 'hand-check';

/** Result of one check. */
export type CheckResult = 'pass' | 'fail' | 'unclear';

/** KRA status for a PAN, as the partner reports it (KycPartner.lookupKyc). */
export type KraStatus = 'validated' | 'registered' | 'on-hold' | 'not-found';

/** The checks a case records a result for. */
export type CheckName =
  | 'kra'
  | 'kra-name'
  | 'kra-dob'
  | 'aadhaar'
  | 'pan'
  | 'pan-name'
  | 'pan-aadhaar-link'
  | 'face-match'
  | 'liveness'
  | 'esign';

/** The next thing the user / system must do while a case is still in progress. */
export type NextStep = 'kra-lookup' | 'aadhaar' | 'pan-check' | 'selfie' | 'esign' | 'kra-upload' | 'wait' | 'none';

/** Machine reason codes; staff free text goes in `note`. */
export type ReasonCode =
  | 'kra-validated'
  | 'full-kyc-passed'
  | 'in-progress'
  | 'check-unclear'
  /** under review only because a partner call still timed out after its retries; a later system retry may verify */
  | 'partner-timeout'
  | 'device-hand-check'
  | 'pan-invalid'
  | 'pan-not-individual'
  | 'aadhaar-mismatch'
  | 'liveness-failed'
  | 'staff-approved'
  | 'staff-rejected';

/** One `kyc_cases` item (design §2). Masks only. */
export interface KycCase {
  userId: string;
  status: KycStatus;
  /** null until the KRA lookup has decided between the fast and full path */
  path: KycPath | null;
  masks: { pan: string; aadhaar: string };
  partnerRefs: { kra?: string; aadhaar?: string; esign?: string; kraUpload?: string };
  checks: Partial<Record<CheckName, CheckResult>>;
  reason: ReasonCode | null;
  /** staff reason text (reject) or note (approve) */
  note?: string;
  updatedAt: string;
  /** optimistic-lock version, +1 on every write */
  version: number;
}
