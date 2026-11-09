// Ports the review routes need (design §3 `/review/*`, R4). Thin views over the shared KycCase
// store and audit log (src/store): `reviewCaseStore(store)` in src/store/views.ts implements
// ReviewCaseStore, and the shared AuditStore implements AuditLog. Documents come from S3 (./s3.ts).
import type { AuditRow } from '../store/types';
import type { KycCase, NextStep } from '../types';

export { BadCursorError, type CaseSnapshot } from '../store/types';

/** One page of cases. `nextCursor` is opaque to callers; absent on the last page. */
export interface CasePage {
  items: KycCase[];
  nextCursor?: string;
}

/** One `audit` item (the shared AuditRow; review rows use the review.* actions). */
export type AuditEntry = AuditRow;

/**
 * A case as the review routes read it. The shared store returns the whole item; the routes only
 * look at `evidence.esign` (R1: was the case e-signed before Approve) and never send it out.
 */
export type ReviewCase = KycCase & {
  evidence?: { esign?: string };
  /**
   * S11 + S14: per-kind upload link, written by the KYC routes. The review routes show and count
   * ONLY 'linked' entries (checked, kept); a 'rejected' one failed the type check.
   */
  documents?: Partial<Record<string, { uploadId: string; state: 'linked' | 'rejected' }>>;
};

export interface ReviewCaseStore {
  /** Under-review cases, newest `updatedAt` first. Throws BadCursorError on a cursor it did not issue. */
  listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage>;
  get(userId: string): Promise<ReviewCase | null>;
  /**
   * Atomically writes the decision fields of `after` (status, path, reason, checks, note, next,
   * updatedAt, version) and the audit row, only if the stored case still has `before.version` and
   * status 'under-review'. Returns 'conflict' when that check fails.
   */
  saveDecision(w: { before: KycCase; after: KycCase; next: NextStep; audit: AuditEntry }): Promise<'ok' | 'conflict'>;
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

/**
 * Lists a case's raw S3 objects. Not used by the review routes any more (F2/S#3: they read the
 * case's own `documents` links); kept for the S3 adapter and its tests.
 */
export interface DocumentStore {
  list(userId: string): Promise<StoredDocument[]>;
}

/** Signs a short-lived GET URL for one document. */
export interface DownloadSigner {
  sign(key: string, expiresInSec: number): Promise<string>;
}
