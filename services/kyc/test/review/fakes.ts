import { FakeClock } from '../../src/lib/clock';
import type { DocumentStore, DownloadSigner, ReviewCaseStore, StoredDocument } from '../../src/review/ports';
import { reviewRoutes, type ReviewRequest } from '../../src/review/routes';
import { MemoryAuditStore, MemoryCaseStore } from '../../src/store/memory';
import type { KycCaseRecord } from '../../src/store/types';
import { reviewCaseStore } from '../../src/store/views';
import type { KycCase } from '../../src/types';

/** Full test numbers: they must never appear in any response. */
export const FULL_PAN = 'ABCPE1234F';
export const FULL_AADHAAR = '234567891234';

/**
 * The review view over the REAL shared memory store, plus test hooks: `put` a case, read the
 * stored items through `map`, or force the next decision to conflict.
 */
export class TestCases implements ReviewCaseStore {
  readonly store: MemoryCaseStore;
  private readonly view: ReviewCaseStore;
  private conflict = false;
  constructor(audit: MemoryAuditStore) {
    this.store = new MemoryCaseStore(audit);
    this.view = reviewCaseStore(this.store);
    this.store.beforeWrite = () => {
      if (this.conflict) this.store.touch([...this.store.all()][0]?.userId ?? '');
    };
  }
  set forceConflict(v: boolean) {
    this.conflict = v;
  }
  get map(): { get(id: string): KycCaseRecord | undefined } {
    return { get: (id) => this.store.all().find((c) => c.userId === id) };
  }
  put(c: KycCase) {
    void this.store.put(c as KycCaseRecord);
  }
  listUnderReview: ReviewCaseStore['listUnderReview'] = (q) => this.view.listUnderReview(q);
  get: ReviewCaseStore['get'] = (id) => this.view.get(id);
  saveDecision: ReviewCaseStore['saveDecision'] = (w) => this.view.saveDecision(w);
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
  const audit = new MemoryAuditStore();
  const cases = new TestCases(audit);
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
