// Ports the partner webhook needs (design §3 `POST /webhooks/partner`, §4, §5). Thin views over
// the shared KycCase store and audit log (src/store): `webhookCaseStore(store)` in
// src/store/views.ts implements WebhookCaseStore, and the shared AuditStore implements
// WebhookAuditLog. Only SeenEventStore has its own table (webhook events, TTL).
import type { DecideInput } from '../decide';
import type { AuditRow, WebhookAction, WebhookOutcome } from '../store/types';
import type { CheckName, KycCase, NextStep } from '../types';

export type {
  CaseEvidence, CaseSnapshot, EvidenceKey, KraUploadStatus, WebhookAction, WebhookOutcome,
} from '../store/types';
import type { CaseEvidence } from '../store/types';

/** Same shape as `KycPartner['verifyWebhook']` (design §4), so any KycPartner satisfies it. */
export interface WebhookVerifier {
  /** `headers` have lower-case names; `body` is the raw request body exactly as received. */
  verifyWebhook(headers: Record<string, string>, body: string): boolean;
}

/** Results the partner reported for a single face-match attempt (KycPartner.faceMatch shape). */
export type FaceAttempt = NonNullable<DecideInput['face']>[number];

/** One `audit` row written by the webhook. Holds no partner result values (names, DOB, scores). */
export type WebhookAuditEntry = AuditRow & {
  actor: 'system';
  action: WebhookAction;
  eventId: string;
  outcome: WebhookOutcome;
};

export interface StoredCase {
  kycCase: KycCase;
  /** null when the case was written without evidence (a contract gap; the webhook retries later) */
  evidence: CaseEvidence | null;
}

export interface WebhookCaseSave {
  before: KycCase;
  after: KycCase;
  evidence: CaseEvidence;
  /** next step / unclear checks from decide(), when the event was decided */
  next?: NextStep;
  unclear?: CheckName[];
  audit: WebhookAuditEntry;
}

export interface WebhookCaseStore {
  get(userId: string): Promise<StoredCase | null>;
  /**
   * Atomically writes `after` + `evidence` (+ next / unclear) and the audit row, only if the stored
   * case still has `before.version`. Returns 'conflict' when that check fails.
   */
  save(w: WebhookCaseSave): Promise<'ok' | 'conflict'>;
}

export interface WebhookAuditLog {
  write(entry: WebhookAuditEntry): Promise<void>;
}

/**
 * Seen partner event ids (replay / duplicate protection), table `TABLE_WEBHOOK_EVENTS`.
 * A claim is a short lease while the event is processed, so a crashed run does not swallow it.
 */
export interface SeenEventStore {
  /** 'claimed' for the one caller that may process the event; 'duplicate' when done or leased. */
  claim(eventId: string, now: number, leaseMs: number, ttlMs: number): Promise<'claimed' | 'duplicate'>;
  /** Marks a claimed event done; it stays a duplicate until `now + ttlMs`. */
  complete(eventId: string, now: number, ttlMs: number): Promise<void>;
  /** Drops a claim after a failed run so the partner's retry is processed. */
  release(eventId: string): Promise<void>;
}

/** Structured log line. Only fixed, non-personal fields: never the body or partner values. */
export interface WebhookLogFields {
  msg: string;
  eventId?: string;
  type?: string;
  outcome?: string;
  status?: number;
  error?: string;
}

export type WebhookLogger = (fields: WebhookLogFields) => void;
