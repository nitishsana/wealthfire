// In-memory webhook stores for tests and local runs.
import type { KycCase } from '../types';
import type {
  CaseEvidence, SeenEventStore, StoredCase, WebhookAuditEntry, WebhookAuditLog, WebhookCaseStore,
} from './ports';

const clone = <T>(v: T): T => structuredClone(v);

interface SeenItem {
  state: 'processing' | 'done';
  leaseUntil: number;
  expiresAt: number;
}

export class MemorySeenEventStore implements SeenEventStore {
  private readonly items = new Map<string, SeenItem>();

  async claim(eventId: string, now: number, leaseMs: number, ttlMs: number): Promise<'claimed' | 'duplicate'> {
    const cur = this.items.get(eventId);
    const expired = cur !== undefined && cur.expiresAt <= now;
    const leaseOver = cur !== undefined && cur.state === 'processing' && cur.leaseUntil < now;
    if (cur && !expired && !leaseOver) return 'duplicate';
    this.items.set(eventId, { state: 'processing', leaseUntil: now + leaseMs, expiresAt: now + ttlMs });
    return 'claimed';
  }

  async complete(eventId: string, now: number, ttlMs: number): Promise<void> {
    this.items.set(eventId, { state: 'done', leaseUntil: 0, expiresAt: now + ttlMs });
  }

  async release(eventId: string): Promise<void> {
    if (this.items.get(eventId)?.state === 'processing') this.items.delete(eventId);
  }

  /** @internal test hook */
  state(eventId: string): SeenItem['state'] | undefined {
    return this.items.get(eventId)?.state;
  }
}

export class MemoryWebhookCaseStore implements WebhookCaseStore {
  private readonly cases = new Map<string, StoredCase>();
  /** audit rows written together with a case change */
  readonly audit: WebhookAuditEntry[] = [];
  /** @internal test hook: called before each save's version check (simulate a concurrent writer) */
  beforeSave?: () => void;

  put(kycCase: KycCase, evidence: CaseEvidence | null): void {
    this.cases.set(kycCase.userId, { kycCase: clone(kycCase), evidence: clone(evidence) });
  }

  async get(userId: string): Promise<StoredCase | null> {
    const c = this.cases.get(userId);
    return c ? clone(c) : null;
  }

  async save(w: { before: KycCase; after: KycCase; evidence: CaseEvidence; audit: WebhookAuditEntry }): Promise<'ok' | 'conflict'> {
    this.beforeSave?.();
    const cur = this.cases.get(w.before.userId);
    if (!cur || cur.kycCase.version !== w.before.version) return 'conflict';
    this.cases.set(w.before.userId, { kycCase: clone(w.after), evidence: clone(w.evidence) });
    this.audit.push(clone(w.audit));
    return 'ok';
  }

  /** @internal test hook: bump the stored version as another writer would */
  touch(userId: string): void {
    const c = this.cases.get(userId);
    if (c) c.kycCase.version += 1;
  }
}

export class MemoryWebhookAuditLog implements WebhookAuditLog {
  readonly entries: WebhookAuditEntry[] = [];

  async write(entry: WebhookAuditEntry): Promise<void> {
    this.entries.push(clone(entry));
  }
}
