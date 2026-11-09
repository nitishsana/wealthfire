// Ports the review routes need (design §3 `/review/*`, R4). The KYC routes builder owns the main
// KycCase repo in src/kyc/; these minimal interfaces keep the review code independent of it.
// DynamoDB / S3 implementations live in ./dynamo.ts and ./s3.ts; tests use in-memory fakes.
import type { KycCase, KycPath, KycStatus, ReasonCode } from '../types';

/** One page of cases. `nextCursor` is opaque to callers; absent on the last page. */
export interface CasePage {
  items: KycCase[];
  nextCursor?: string;
}

/** The part of a case an audit row records before / after a change. */
export interface CaseSnapshot {
  status: KycStatus;
  path: KycPath | null;
  reason: ReasonCode | null;
  version: number;
}

/** One `audit` item (design §2: key userId + ts). Never holds PAN, Aadhaar, tokens or document data. */
export interface AuditEntry {
  userId: string;
  /** ISO time + '#' + nonce, so two rows in the same millisecond never collide */
  ts: string;
  /** 'system' or 'staff:<cognito sub>' */
  actor: string;
  action: 'review.view' | 'review.approve' | 'review.reject';
  before: CaseSnapshot | null;
  after: CaseSnapshot | null;
  /** staff reason (reject) or note (approve) */
  note?: string;
}

export interface ReviewCaseStore {
  /** Under-review cases, newest `updatedAt` first. Throws BadCursorError on a cursor it did not issue. */
  listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage>;
  get(userId: string): Promise<KycCase | null>;
  /**
   * Atomically writes `after` and the audit row, only if the stored case still has
   * `before.version` and status 'under-review'. Returns 'conflict' when that check fails.
   */
  saveDecision(w: { before: KycCase; after: KycCase; audit: AuditEntry }): Promise<'ok' | 'conflict'>;
}

export interface AuditLog {
  write(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  listForUser(userId: string, limit: number): Promise<AuditEntry[]>;
}

export type DocumentKind = 'selfie' | 'aadhaar' | 'pan' | 'other';

export interface StoredDocument {
  kind: DocumentKind;
  /** S3 object key; never sent to the browser */
  key: string;
  uploadedAt?: string;
}

/** Lists a case's uploaded documents. */
export interface DocumentStore {
  list(userId: string): Promise<StoredDocument[]>;
}

/** Signs a short-lived GET URL for one document. */
export interface DownloadSigner {
  sign(key: string, expiresInSec: number): Promise<string>;
}

export class BadCursorError extends Error {
  constructor() {
    super('bad cursor');
    this.name = 'BadCursorError';
  }
}
