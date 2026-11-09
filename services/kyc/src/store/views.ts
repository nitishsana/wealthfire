// Thin views of the shared CaseStore for the review routes and the webhook. No storage logic of
// their own: every write is one CaseStore.update (version-checked, audit row in the same transaction).
import type { ReviewCaseStore } from '../review/ports';
import type { KycCase, NextStep } from '../types';
import type { StoredCase, WebhookCaseSave, WebhookCaseStore } from '../webhook/ports';
import type { AuditRow, CaseStore, KycCaseRecord } from './types';

const CASE_FIELDS = [
  'userId', 'status', 'path', 'masks', 'partnerRefs', 'checks', 'reason', 'note', 'updatedAt', 'version',
] as const satisfies readonly (keyof KycCase)[];

/** ReviewCaseStore over the shared store: a staff decision only writes the decision fields. */
export function reviewCaseStore(store: CaseStore): ReviewCaseStore {
  return {
    listUnderReview: (q) => store.listUnderReview(q),
    get: (userId) => store.get(userId),
    async saveDecision(w: { before: KycCase; after: KycCase; next: NextStep; audit: AuditRow }) {
      const a = w.after;
      return store.update({
        userId: w.before.userId,
        expectedVersion: w.before.version,
        requireStatus: 'under-review',
        set: {
          status: a.status, path: a.path, reason: a.reason, checks: a.checks, next: w.next, updatedAt: a.updatedAt,
          ...(a.note !== undefined ? { note: a.note } : {}),
        },
        remove: a.note === undefined ? ['note', 'unclear'] : ['unclear'],
        audit: w.audit,
      });
    },
  };
}

/** WebhookCaseStore over the shared store: splits / merges the `evidence` attribute. */
export function webhookCaseStore(store: CaseStore): WebhookCaseStore {
  return {
    async get(userId: string): Promise<StoredCase | null> {
      const rec = (await store.get(userId)) as (Partial<KycCaseRecord> & KycCase) | null;
      if (!rec) return null;
      // Only the KycCase fields: the webhook never sees panEnc / panHash.
      const kycCase = {
        path: null, reason: null, partnerRefs: {}, checks: {}, masks: { pan: '', aadhaar: '' }, version: 0,
      } as unknown as Record<string, unknown>;
      for (const k of CASE_FIELDS) if (rec[k] !== undefined) kycCase[k] = rec[k];
      return { kycCase: kycCase as unknown as KycCase, evidence: rec.evidence ?? null };
    },
    async save(w: WebhookCaseSave) {
      const a = w.after;
      return store.update({
        userId: w.before.userId,
        expectedVersion: w.before.version,
        set: {
          status: a.status, path: a.path, reason: a.reason, checks: a.checks, partnerRefs: a.partnerRefs,
          evidence: w.evidence, updatedAt: a.updatedAt,
          ...(w.next !== undefined ? { next: w.next } : {}),
          ...(w.unclear !== undefined && w.unclear.length > 0 ? { unclear: w.unclear } : {}),
        },
        ...(w.next !== undefined && (w.unclear === undefined || w.unclear.length === 0) ? { remove: ['unclear' as const] } : {}),
        audit: w.audit,
      });
    },
  };
}
