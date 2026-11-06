// Number check: compare what the user typed with what the document reader found.
// FieldCheck objects hold the full Aadhaar, so they live in screen state only. Only
// checkOutcome, the final PAN, the Aadhaar last 4 and reviewFields reach the store.
import type { AppData, KycField, KycMatch, KycState, KycStatus, ReviewRecord } from './types';
import { maskAadhaar, maskPan, normalizeAadhaar, normalizePan } from './onboarding';

export const MAX_REREADS = 2;

export interface FieldCheck {
  field: KycField;
  typed: string;
  read: string;
  final: string;
  matched: boolean;
  rereads: number;
  source: 'typed' | 'document' | 'edited';
  /** Name on this card vs the entered name: true / false, or null when not checked (no name given). */
  nameMatch: boolean | null;
}

const norm = (field: KycField, v: string) => (field === 'pan' ? normalizePan(v) : normalizeAadhaar(v));

/** Normalize both sides, then compare exactly. */
export function compareField(field: KycField, typed: string, read: string): boolean {
  const a = norm(field, typed);
  return a !== '' && a === norm(field, read);
}

/** One check per field, PAN first, from the typed numbers and the first read. */
export function initialChecks(
  typed: { pan: string; aadhaar: string },
  read: { pan: string; aadhaar: string },
  nameMatch?: { pan: boolean | null; aadhaar: boolean | null },
): FieldCheck[] {
  return (['pan', 'aadhaar'] as const).map((field) => {
    const t = norm(field, typed[field]);
    const r = norm(field, read[field]);
    return {
      field, typed: t, read: r, final: t, matched: compareField(field, t, r), rereads: 0, source: 'typed',
      nameMatch: nameMatch?.[field] ?? null,
    };
  });
}

/**
 * "Use number from document": the read number becomes final. It counts as matched ONLY when the
 * name on that card matched (nameMatch === true); otherwise the check goes to review.
 */
export function takeDocumentNumber(c: FieldCheck): FieldCheck {
  return { ...c, final: c.read, matched: c.nameMatch === true, source: 'document' };
}

/** Stored re-reads left for a field (0..MAX_REREADS). */
export function readsLeft(kyc: KycState, field: KycField): number {
  return Math.max(0, MAX_REREADS - kyc.rereads[field]);
}

/**
 * Bug 1 (no re-read bypass via Back). After Back from Check numbers, `kyc.returnedFromCheck`
 * is true and the next `documents-ready` counts one re-read for every field.
 * How UIs must use this:
 * - On Continue on Documents, call readBlocked(kyc, field) for each field BEFORE reading.
 * - If it is true, do not read that field again: keep its earlier read result (screen state)
 *   and seed the check with it. Read only the fields that are not blocked.
 * - Then dispatch `documents-ready` as usual. Do NOT also dispatch `reread-used` for this
 *   path: the reducer already counts it. `reread-used` stays only for "Edit number" /
 *   "Upload again" on the Check screen (guard those with readsLeft / canReread).
 * - The counts are stored, so a reload does not reset them. The flag is cleared on reload
 *   (sanitizeOnboarding): the earlier read results were in memory only, so nothing is blocked
 *   without a result to show.
 */
export function readBlocked(kyc: KycState, field: KycField): boolean {
  return kyc.returnedFromCheck && kyc.rereads[field] >= MAX_REREADS;
}

export function canReread(c: FieldCheck): boolean {
  return c.rereads < MAX_REREADS;
}

/**
 * Record a strict re-read ("Edit number" or "Upload again"). `final` is the number the user
 * now stands by; `reread` is what the reader found. Blocked (unchanged) after MAX_REREADS.
 */
export function applyReread(c: FieldCheck, final: string, reread: string, nameMatch?: boolean | null): FieldCheck {
  if (!canReread(c)) return c;
  const f = norm(c.field, final);
  const r = norm(c.field, reread);
  return {
    ...c,
    final: f,
    read: r,
    matched: compareField(c.field, f, r),
    rereads: c.rereads + 1,
    source: f === c.typed ? 'typed' : 'edited',
    // a new read of the card may bring a new name result; without one the earlier result stays
    nameMatch: nameMatch === undefined ? c.nameMatch : nameMatch,
  };
}

/** A field needs a person to look at it: the numbers differ, or the name on the card didn't match. */
const needsReview = (c: FieldCheck) => !c.matched || c.nameMatch === false;

/**
 * 'matched' only when every field matched AND no card's name failed (nameMatch === false);
 * otherwise 'review' with the fields that need it (a name failure lists that card's field).
 */
export function checkOutcome(cs: FieldCheck[]): { match: KycMatch; differs: KycField[] } {
  const differs = cs.filter(needsReview).map((c) => c.field);
  return { match: differs.length ? 'review' : 'matched', differs };
}

const mask = (field: KycField, v: string) => (field === 'pan' ? maskPan(v) : maskAadhaar(normalizeAadhaar(v).slice(-4)));

/** Masked typed (final) vs read numbers for the fields that differ. Never a full Aadhaar. */
export function reviewFields(cs: FieldCheck[]): ReviewRecord['fields'] {
  return cs
    .filter(needsReview)
    .map((c) => ({
      field: c.field, typedMasked: mask(c.field, c.final), readMasked: mask(c.field, c.read),
      ...(c.nameMatch === false ? { nameMismatch: true as const } : {}),
    }));
}

/**
 * Investing is allowed only after onboarding is done and KYC is verified.
 * Client-side only: the future investment journey must re-check this on a server.
 */
export function isEligibleToInvest(data: AppData): boolean {
  return data.onboarding?.step === 'done' && data.onboarding.kyc?.status === 'verified';
}

export function kycStatusLabel(s: KycStatus | null): string {
  switch (s) {
    case 'verified': return 'Verified';
    case 'under-review': return 'Under review';
    case 'rejected': return 'Review rejected';
    default: return 'Not started';
  }
}
