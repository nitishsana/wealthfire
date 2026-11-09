import { FakeClock } from '../../src/lib/clock';
import {
  BadCursorError,
  type AuditEntry,
  type AuditLog,
  type CasePage,
  type DocumentStore,
  type DownloadSigner,
  type ReviewCaseStore,
  type StoredDocument,
} from '../../src/review/ports';
import { reviewRoutes, type ReviewRequest } from '../../src/review/routes';
import type { KycCase } from '../../src/types';

/** Full test numbers: they must never appear in any response. */
export const FULL_PAN = 'ABCPE1234F';
export const FULL_AADHAAR = '234567891234';

export class MemoryAudit implements AuditLog {
  rows: AuditEntry[] = [];
  async write(e: AuditEntry) {
    this.rows.push(structuredClone(e));
  }
  async listForUser(userId: string, limit: number) {
    return this.rows.filter((r) => r.userId === userId).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }
}

export class MemoryCases implements ReviewCaseStore {
  map = new Map<string, KycCase>();
  forceConflict = false;
  constructor(private readonly audit: MemoryAudit) {}
  put(c: KycCase) {
    this.map.set(c.userId, structuredClone(c));
  }
  async listUnderReview(q: { limit: number; cursor?: string }): Promise<CasePage> {
    const all = [...this.map.values()]
      .filter((c) => c.status === 'under-review')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    let start = 0;
    if (q.cursor !== undefined) {
      start = Number(q.cursor.replace(/^c/, ''));
      if (!/^c\d+$/.test(q.cursor)) throw new BadCursorError();
    }
    const items = all.slice(start, start + q.limit).map((c) => structuredClone(c));
    const next = start + q.limit < all.length ? `c${start + q.limit}` : undefined;
    return { items, ...(next ? { nextCursor: next } : {}) };
  }
  async get(id: string) {
    const c = this.map.get(id);
    return c ? structuredClone(c) : null;
  }
  async saveDecision(w: { before: KycCase; after: KycCase; audit: AuditEntry }) {
    const cur = this.map.get(w.before.userId);
    if (this.forceConflict || !cur || cur.version !== w.before.version || cur.status !== 'under-review') return 'conflict' as const;
    this.map.set(w.after.userId, structuredClone(w.after));
    await this.audit.write(w.audit);
    return 'ok' as const;
  }
}

export class MemoryDocs implements DocumentStore {
  docs = new Map<string, StoredDocument[]>();
  async list(userId: string) {
    return this.docs.get(userId) ?? [];
  }
}

export class FakeSigner implements DownloadSigner {
  calls: { key: string; expiresInSec: number }[] = [];
  async sign(key: string, expiresInSec: number) {
    this.calls.push({ key, expiresInSec });
    return `https://signed.example/${this.calls.length}?X-Amz-Expires=${expiresInSec}`;
  }
}

export function makeCase(over: Partial<KycCase> = {}): KycCase {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    status: 'under-review',
    path: 'full-kyc',
    // deliberately unmasked: the routes must re-mask
    masks: { pan: FULL_PAN, aadhaar: FULL_AADHAAR },
    partnerRefs: { kra: 'kra-ref-1' },
    checks: { aadhaar: 'pass', pan: 'pass', 'face-match': 'unclear' },
    reason: 'check-unclear',
    updatedAt: '2026-11-06T10:00:00.000Z',
    version: 3,
    ...over,
  };
}

export function setup() {
  const clock = new FakeClock();
  const audit = new MemoryAudit();
  const cases = new MemoryCases(audit);
  const documents = new MemoryDocs();
  const signer = new FakeSigner();
  let n = 0;
  const routes = reviewRoutes({ cases, audit, documents, signer, clock, nonce: () => `n${++n}` });
  return { clock, audit, cases, documents, signer, routes };
}

export const REVIEWER = { id: 'staff-sub-1', groups: ['reviewer'] };

export function req(over: Partial<ReviewRequest> = {}): ReviewRequest {
  return { params: {}, query: {}, body: undefined, staff: REVIEWER, ...over };
}
