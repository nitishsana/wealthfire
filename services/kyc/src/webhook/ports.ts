// Ports the partner webhook needs (design §3 `POST /webhooks/partner`, §4, §5). The KYC routes
// builder owns the main KycPartner (src/partner/) and KycCase repo (src/kyc/); these minimal,
// structurally compatible interfaces keep the webhook independent of them until they are reconciled.
import type { DecideInput } from '../decide';
import type { KycCase, KycPath, KycStatus, ReasonCode } from '../types';

/** Same shape as `KycPartner['verifyWebhook']` (design §4), so any KycPartner satisfies it. */
export interface WebhookVerifier {
  /** `headers` have lower-case names; `body` is the raw request body exactly as received. */
  verifyWebhook(headers: Record<string, string>, body: string): boolean;
}

/** Results the partner reported for a single face-match attempt (KycPartner.faceMatch shape). */
export type FaceAttempt = NonNullable<DecideInput['face']>[number];

/** Keys the out-of-order guard tracks (latest applied partner event time per check). */
export type EvidenceKey = 'kra' | 'aadhaar' | 'pan' | 'esign' | 'kra-upload';

export type KraUploadStatus = 'pending' | 'uploaded' | 'rejected';

/**
 * Everything `decide()` needs except the current status, stored with the case (the `evidence`
 * attribute of the `kyc_cases` item). The KYC routes builder writes the base fields at
 * `/kyc/start`; the webhook adds partner results. Masks only: never a full PAN or Aadhaar.
 */
export type CaseEvidence = Omit<DecideInput, 'current'> & {
  /** partner event time (epoch ms) of each face attempt, parallel to `face`; missing = 0 */
  faceTs?: number[];
  /** the partner reported the Aadhaar eKYC as not verified (a real doubt, not a timeout) */
  aadhaarFailed?: boolean;
  /** KRA upload status after a verified case (design §5 row 2 "then KRA upload") */
  kraUpload?: { status: KraUploadStatus };
  /** latest partner event time (epoch ms) applied per check; an older event is ignored */
  eventTs?: Partial<Record<EvidenceKey, number>>;
};

/** The part of a case an audit row records before / after a change (same as review/ports.ts). */
export interface CaseSnapshot {
  status: KycStatus;
  path: KycPath | null;
  reason: ReasonCode | null;
  version: number;
}

export type WebhookAction = 'webhook.kyc-result' | 'webhook.esign' | 'webhook.kra-upload';

export type WebhookOutcome =
  | 'applied'
  | 'ignored-unknown-case'
  | 'ignored-terminal'
  | 'ignored-stale'
  | 'ignored-ref-mismatch'
  | 'ignored-not-verified';

/** One `audit` item written by the webhook. Holds no partner result values (names, DOB, scores). */
export interface WebhookAuditEntry {
  userId: string;
  /** ISO time + '#' + event id, so two rows in the same millisecond never collide */
  ts: string;
  actor: 'system';
  action: WebhookAction;
  eventId: string;
  outcome: WebhookOutcome;
  /** which partner check the event carried (kyc.result only) */
  check?: string;
  before: CaseSnapshot | null;
  after: CaseSnapshot | null;
}

export interface StoredCase {
  kycCase: KycCase;
  /** null when the case was written without evidence (a contract gap; the webhook retries later) */
  evidence: CaseEvidence | null;
}

export interface WebhookCaseStore {
  get(userId: string): Promise<StoredCase | null>;
  /**
   * Atomically writes `after` + `evidence` and the audit row, only if the stored case still has
   * `before.version`. Returns 'conflict' when that check fails.
   */
  save(w: { before: KycCase; after: KycCase; evidence: CaseEvidence; audit: WebhookAuditEntry }): Promise<'ok' | 'conflict'>;
}

export interface WebhookAuditLog {
  write(entry: WebhookAuditEntry): Promise<void>;
}

/**
 * Seen partner event ids (replay / duplicate protection), table `WEBHOOK_EVENTS_TABLE`.
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
