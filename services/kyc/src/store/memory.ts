// In-memory CaseStore + AuditStore (tests, local runs). Same semantics as ./dynamo.ts.
import {
  archiveKey, archivedRecord, BadCursorError, type ArchivedCase, type AuditRow, type AuditStore, type CasePage, type CaseStore, type CaseUpdate, type KycCaseRecord,
} from './types';

const clone = <T>(v: T): T => structuredClone(v);

const newestFirst = (a: { updatedAt: string; userId: string }, b: { updatedAt: string; userId: string }): number =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.userId < b.userId ? 1 : a.userId > b.userId ? -1 : 0;

export class MemoryAuditStore implements AuditStore {
  readonly rows: AuditRow[] = [];

  async write(row: AuditRow): Promise<void> {
    if (this.rows.some((r) => r.userId === row.userId && r.ts === row.ts)) return;
    this.rows.push(clone(row));
  }

  async listForUser(userId: string, limit?: number): Promise<AuditRow[]> {
    const rows = this.rows.filter((r) => r.userId === userId).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return (limit === undefined ? rows : rows.slice(0, limit)).map(clone);
  }

  /** @internal test hook: rows in write order */
  all(): AuditRow[] {
    return this.rows.map(clone);
  }
}

export class MemoryCaseStore implements CaseStore {
  private readonly items = new Map<string, KycCaseRecord>();
  private readonly pans = new Map<string, string>();
  /** @internal test hook: runs before each write's version check (simulate a concurrent writer) */
  beforeWrite?: () => void;

  constructor(private readonly audit: MemoryAuditStore = new MemoryAuditStore()) {}

  async get(userId: string): Promise<KycCaseRecord | null> {
    const c = this.items.get(userId);
    return c ? clone(c) : null;
  }

  async save(rec: KycCaseRecord, expectedVersion: number, audit?: AuditRow): Promise<boolean> {
    this.beforeWrite?.();
    const cur = this.items.get(rec.userId)?.version ?? 0;
    if (cur !== expectedVersion || rec.version !== expectedVersion + 1) return false;
    this.items.set(rec.userId, clone(rec));
    if (audit) await this.audit.write(audit);
    return true;
  }

  async update(u: CaseUpdate): Promise<'ok' | 'conflict'> {
    this.beforeWrite?.();
    const cur = this.items.get(u.userId);
    if (!cur || cur.version !== u.expectedVersion) return 'conflict';
    if (u.requireStatus !== undefined && cur.status !== u.requireStatus) return 'conflict';
    const set = Object.fromEntries(Object.entries(u.set).filter(([, v]) => v !== undefined));
    const next = { ...clone(cur), ...clone(set), version: u.expectedVersion + 1 } as KycCaseRecord;
    for (const k of u.remove ?? []) delete next[k];
    this.items.set(u.userId, next);
    await this.audit.write(u.audit);
    return 'ok';
  }

  async listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage> {
    const all = [...this.items.values()].filter((c) => c.status === 'under-review').sort(newestFirst);
    let start = 0;
    if (q.cursor !== undefined) {
      if (!/^m\d{1,6}$/.test(q.cursor)) throw new BadCursorError();
      start = Number(q.cursor.slice(1));
    }
    const items = all.slice(start, start + q.limit).map(clone);
    const end = start + q.limit;
    return { items, ...(end < all.length ? { nextCursor: `m${end}` } : {}) };
  }

  async claimPan(panHash: string, userId: string): Promise<boolean> {
    const owner = this.pans.get(panHash);
    if (owner !== undefined && owner !== userId) return false;
    this.pans.set(panHash, userId);
    return true;
  }

  async releasePan(panHash: string, userId: string): Promise<void> {
    if (this.pans.get(panHash) === userId) this.pans.delete(panHash);
  }

  /** archived cases by archive key (`arch#<userId>#<time>`) */
  readonly archived = new Map<string, ArchivedCase>();

  async archive(userId: string, expectedVersion: number, archivedAt: string, audit: AuditRow): Promise<boolean> {
    this.beforeWrite?.();
    const cur = this.items.get(userId);
    if (!cur || cur.version !== expectedVersion) return false;
    this.archived.set(archiveKey(userId, archivedAt), archivedRecord(cur));
    this.items.delete(userId);
    await this.audit.write(audit);
    return true;
  }

  async remove(userId: string, expectedVersion: number, audit: AuditRow): Promise<boolean> {
    this.beforeWrite?.();
    const cur = this.items.get(userId);
    if (!cur || cur.version !== expectedVersion) return false;
    this.items.delete(userId);
    await this.audit.write(audit);
    return true;
  }

  async removeArchived(userId: string): Promise<number> {
    const prefix = archiveKey(userId, '');
    let n = 0;
    for (const k of [...this.archived.keys()]) {
      if (k.startsWith(prefix)) {
        this.archived.delete(k);
        n++;
      }
    }
    return n;
  }

  /** @internal test hook: who holds a PAN claim */
  panOwner(panHash: string): string | undefined {
    return this.pans.get(panHash);
  }

  /** @internal test hook: raw stored cases */
  all(): KycCaseRecord[] {
    return [...this.items.values()].map(clone);
  }

  /** @internal test hook: write an item as another writer would (no checks, no audit) */
  async put(rec: KycCaseRecord): Promise<void> {
    this.items.set(rec.userId, clone(rec));
  }

  /** @internal test hook: bump the stored version as another writer would */
  touch(userId: string): void {
    const c = this.items.get(userId);
    if (c) c.version += 1;
  }
}

/** A store and its audit log, wired together (case writes and their audit rows land in `audit`). */
export function memoryStore(): { cases: MemoryCaseStore; audit: MemoryAuditStore } {
  const audit = new MemoryAuditStore();
  return { cases: new MemoryCaseStore(audit), audit };
}
