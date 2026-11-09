// The ONE KycCase store and audit log shared by the KYC routes (src/kyc), the partner webhook
// (src/webhook) and the staff review routes (src/review). One `kyc_cases` item shape, one evidence
// shape, one audit row shape. Implementations: ./memory.ts (tests, local) and ./dynamo.ts (Lambda).
// src/review/ports.ts and src/webhook/ports.ts are thin views over these (see ./views.ts).
//
// DynamoDB layout:
//   kyc_cases pk userId   case items (KycCaseRecord, have `status` so they appear in GSI byStatus)
//                         `pan#<panHash>` items: { ownerId } — one PAN per account (no `status`)
//                         `idem#<hash>` items: idempotency records (src/kyc/repo.ts; no `status`)
//   audit     pk userId, sk ts (ISO time + '#' + nonce or event id)
//
// A case item never holds a full Aadhaar number, and the PAN only encrypted (`panEnc`) plus an
// HMAC lookup key (`panHash`).
import type { DecideInput } from '../decide';
import type { CheckName, KycCase, KycPath, KycStatus, NextStep, ReasonCode } from '../types';

export type Timeout = 'timeout';

/** Keys the webhook's out-of-order guard tracks (latest applied partner event time per check). */
export type EvidenceKey = 'kra' | 'aadhaar' | 'pan' | 'esign' | 'kra-upload';

export type KraUploadStatus = 'pending' | 'uploaded' | 'rejected';

/**
 * Everything decide() needs except the current status / reason (the `evidence` attribute).
 * `/kyc/start` writes the base fields; the KYC routes and the webhook add partner results.
 * Masks only: never a full PAN or Aadhaar.
 */
export type CaseEvidence = Omit<DecideInput, 'current' | 'currentReason'> & {
  /** partner event time (epoch ms) of each face attempt, parallel to `face`; missing = 0 */
  faceTs?: number[];
  /** the partner reported the Aadhaar eKYC as not verified (a real doubt, not a timeout) */
  aadhaarFailed?: boolean;
  /** KRA upload status reported by the partner after a verified case */
  kraUpload?: { status: KraUploadStatus };
  /** latest partner event time (epoch ms) applied per check; an older event is ignored */
  eventTs?: Partial<Record<EvidenceKey, number>>;
};

/** One `kyc_cases` item: the shared KycCase fields plus what the KYC routes need. */
export interface KycCaseRecord extends KycCase {
  createdAt: string;
  /** Encryptor output of the normalised PAN (context {purpose:'pan', userId}) */
  panEnc: string;
  /** hmacLookup(mac, 'pan', PAN) */
  panHash: string;
  evidence: CaseEvidence;
  /** last decided next step */
  next: NextStep;
  unclear?: CheckName[];
}

/** The part of a case an audit row records before / after a change. */
export interface CaseSnapshot {
  status: KycStatus;
  path: KycPath | null;
  reason: ReasonCode | null;
  version: number;
}

export type ReviewAction = 'review.view' | 'review.approve' | 'review.reject';
export type WebhookAction = 'webhook.kyc-result' | 'webhook.esign' | 'webhook.kra-upload';
/** `kyc.*` rows are system actions written by the KYC routes (kyc.start, kyc.kra-upload, ...). */
export type AuditAction = ReviewAction | WebhookAction | `kyc.${string}`;

export type WebhookOutcome =
  | 'applied'
  | 'ignored-unknown-case'
  | 'ignored-terminal'
  | 'ignored-stale'
  | 'ignored-ref-mismatch'
  | 'ignored-not-verified';

export type Actor = 'system' | `staff:${string}`;

/** One `audit` item. Never holds PAN, Aadhaar, contacts, tokens, partner values or document data. */
export interface AuditRow {
  userId: string;
  /** ISO time + '#' + nonce (or event id), so two rows in the same millisecond never collide */
  ts: string;
  actor: Actor;
  action: AuditAction;
  before: CaseSnapshot | null;
  after: CaseSnapshot | null;
  /** staff reason (reject) or note (approve) */
  note?: string;
  ip?: string;
  /** webhook rows */
  eventId?: string;
  outcome?: WebhookOutcome;
  check?: string;
}

/** Fields a partial case update may set (everything else on the item is left as it is). */
export type CaseFields = Pick<
  KycCaseRecord,
  'status' | 'path' | 'reason' | 'checks' | 'partnerRefs' | 'evidence' | 'next' | 'unclear' | 'note' | 'updatedAt'
>;

export interface CaseUpdate {
  userId: string;
  /** stored version the change is based on; the write sets version expectedVersion + 1 */
  expectedVersion: number;
  set: Partial<CaseFields>;
  /** optional fields to drop (e.g. a stale staff note) */
  remove?: ('note' | 'unclear')[];
  /** extra condition: the stored case must still have this status */
  requireStatus?: KycStatus;
  /** written in the same transaction */
  audit: AuditRow;
}

/** One page of cases. `nextCursor` is opaque to callers; absent on the last page. */
export interface CasePage {
  items: KycCaseRecord[];
  nextCursor?: string;
}

export class BadCursorError extends Error {
  constructor() {
    super('bad cursor');
    this.name = 'BadCursorError';
  }
}

export interface CaseStore {
  get(userId: string): Promise<KycCaseRecord | null>;
  /**
   * Writes the whole record (version must be expectedVersion + 1; expectedVersion 0 = must not
   * exist) and, in the same transaction, the audit row if given. False on a concurrent change.
   */
  save(rec: KycCaseRecord, expectedVersion: number, audit?: AuditRow): Promise<boolean>;
  /** Partial, version-checked update + audit row in one transaction. 'conflict' when a condition fails. */
  update(u: CaseUpdate): Promise<'ok' | 'conflict'>;
  /** Under-review cases, newest `updatedAt` first. Throws BadCursorError on a cursor it did not issue. */
  listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage>;
  /**
   * Claims a PAN (by its HMAC lookup key) for one account. True when it is free or already this
   * user's; false when another account holds it. Never reveals which account.
   */
  claimPan(panHash: string, userId: string): Promise<boolean>;
}

export interface AuditStore {
  /** Idempotent on (userId, ts): writing the same row twice keeps one. */
  write(row: AuditRow): Promise<void>;
  /** Newest first. */
  listForUser(userId: string, limit?: number): Promise<AuditRow[]>;
}

export function snapshotOf(c: KycCase): CaseSnapshot {
  return { status: c.status, path: c.path, reason: c.reason, version: c.version };
}

export const PAN_PREFIX = 'pan#';
export const IDEM_PREFIX = 'idem#';
/** Keys that are not cases (pointer / idempotency items share the table). */
export const isCaseKey = (userId: string): boolean => !userId.startsWith(PAN_PREFIX) && !userId.startsWith(IDEM_PREFIX);
