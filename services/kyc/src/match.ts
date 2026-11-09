// Name and date-of-birth matching for the KRA fast path (design §5). Same rules as
// packages/core nameOnCard (exact first name words leading, surname as the last word(s), no typo
// allowance, shared prefixes go to review) but OCR-free: a KRA name is clean text, so there is no
// digit-for-letter or L/I, RN/M, VV/W leniency.
import { validatePan } from '@wealthfire/core';
import type { CheckResult } from './types';

/** Local equivalent of core's (unexported) nameWords: uppercase Latin letters only, split into words. */
export function nameWords(s: string): string[] {
  return s.toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Local copy of core's (unexported) SHARED_PREFIXES in cardtext.ts. */
export const SHARED_PREFIXES: ReadonlySet<string> = new Set([
  'MOHAMMED', 'MOHAMMAD', 'MOHAMED', 'MOHAMAD', 'MUHAMMAD', 'MUHAMMED', 'MOHD', 'MD',
  'SYED', 'SAYYED', 'SAIYED', 'SHAIK', 'SHAIKH', 'SHEIK', 'SHEIKH', 'SK', 'SRI', 'SHRI', 'SREE', 'SHREE',
]);

/**
 * Typed name vs the KRA name.
 * - 'unclear': typed first or last name has no Latin letters (can't compare); the KRA name shows
 *   only an initial that agrees with the typed first name ("N K SANA"); or only a shared prefix
 *   (Mohammed, Syed, …) was typed and the KRA name has more words before the surname.
 * - 'fail': one-letter typed first name; KRA name too short; surname is not the KRA name's last
 *   word(s); typed first-name words are not the KRA name's leading words, in order.
 * - 'pass': otherwise.
 */
export function nameMatches(typedFirst: string, typedLast: string, kraName: string): CheckResult {
  const first = nameWords(typedFirst);
  const last = nameWords(typedLast);
  if (first.length === 0 || last.length === 0) return 'unclear';
  if (first[0]!.length === 1) return 'fail';
  const kra = nameWords(kraName);
  if (kra.length < first.length + last.length) return 'fail';
  const tail = kra.slice(-last.length);
  if (!last.every((w, i) => w === tail[i])) return 'fail';
  const head = kra[0]!;
  if (head.length === 1) return head === first[0]![0] ? 'unclear' : 'fail';
  if (!first.every((w, i) => w === kra[i])) return 'fail';
  const more = kra.length - last.length > first.length;
  if (first.length === 1 && SHARED_PREFIXES.has(first[0]!) && more) return 'unclear';
  return 'pass';
}

/** 'dd/mm/yyyy' or 'yyyy-mm-dd' → 'yyyy-mm-dd'; null when neither shape or not a real date. */
export function parseDob(s: string): string | null {
  const v = s.trim();
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  let y: number, m: number, d: number;
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Same calendar date; false when either side is missing, malformed or not a real date. */
export function dobMatches(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const x = parseDob(a);
  return x !== null && x === parseDob(b);
}

/** Individual PAN (4th char 'P', valid shape): reuses core validatePan. */
export function isIndividualPan(pan: string): boolean {
  return validatePan(pan) === null;
}
