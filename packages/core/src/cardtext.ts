// Card text parsers for the on-device document reader. Platform-free: each app supplies the
// OCR text (one string per pass); core finds the PAN / Aadhaar number in it.
// OCR text is never stored or logged; only the parsed number leaves this module.
import { verhoeffValid } from './onboarding';

export interface CardParse {
  /** card keywords found */
  looksLikeCard: boolean;
  /** best valid number in this text, normalized; null when none or a tie */
  value: string | null;
  /** Aadhaar shown as XXXX XXXX 1234 and no full number found */
  masked: boolean;
  /** every valid number found, in order, repeats kept (for the majority across passes) */
  candidates: string[];
}

/** PAN-only words. "GOVT. OF INDIA" is on many documents, so it never counts on its own. */
const PAN_KEYWORDS = /INCOME\s*TAX\s*DEPARTMENT|PERMANENT\s*ACCOUNT\s*NUMBER|आयकर\s*विभाग/i;
/** Labels printed on the card itself (an ITR or a letter rarely has them next to the PAN words). */
const PAN_CUES = /\bNAME\b|\bFATHER|\bDATE\s*OF\s*BIRTH\b|\bDOB\b|नाम|जन्म/i;
/** Income-tax return / acknowledgement text: has the PAN words and the PAN, but is not the card. */
const PAN_REJECT = /ACKNOWLEDG(?:E)?MENT|ASSESSMENT\s*YEAR|\bITR\b/i;
/** Words only an Aadhaar shows; "Government of India" / "भारत सरकार" also appear on other cards, so they never count. */
const AADHAAR_KEYWORDS = /AADHAAR|AADHAR|आधार|UNIQUE\s*IDENTIFICATION\s*AUTHORITY/i;
/** Labels printed on an Aadhaar card or e-Aadhaar. */
const AADHAAR_CUES = /\bDOB\b|\bDATE\s*OF\s*BIRTH\b|\bYEAR\s*OF\s*BIRTH\b|\bMALE\b|\bFEMALE\b|पुरुष|महिला|\bENROL?MENT\b|\bADDRESS\b/i;

/** PAN shape (any valid 4th-char holder type, so a company PAN is reported, not dropped). */
const PAN_SHAPE = /^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/;
const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' };
const TO_DIGIT: Record<string, string> = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2' };

/** Fix common OCR swaps by position: letters at 1–5 and 10, digits at 6–9. */
export function fixPanSwaps(token: string): string {
  if (token.length !== 10) return token;
  return [...token.toUpperCase()]
    .map((ch, i) => (i >= 5 && i <= 8 ? (TO_DIGIT[ch] ?? ch) : (TO_LETTER[ch] ?? ch)))
    .join('');
}

/** Most frequent value; null when there is none or the top count is tied between different values. */
export function pickMajority(values: readonly (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let top = 0;
  let tie = false;
  for (const [v, n] of counts) {
    if (n > top) { best = v; top = n; tie = false; } else if (n === top) tie = true;
  }
  return tie ? null : best;
}

/**
 * 10-char tokens per line: single words, and runs of neighbouring words (e.g. "ABCPE 1234 F").
 * `words` is how many words the token spans (1 = a clean single word).
 */
function panTokens(line: string): { token: string; words: number }[] {
  const words = line.toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const out: { token: string; words: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let j = i; j < words.length && joined.length < 10; j++) {
      joined += words[j];
      if (joined.length === 10) out.push({ token: joined, words: j - i + 1 });
    }
  }
  return out;
}

export function parsePanText(text: string): CardParse {
  const looksLikeCard = PAN_KEYWORDS.test(text) && PAN_CUES.test(text) && !PAN_REJECT.test(text);
  const found: { pan: string; words: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const { token, words } of panTokens(line)) {
      if (/^\d+$/.test(token)) continue; // an all-digit run (phone, account no.) is never a PAN
      const fixed = fixPanSwaps(token);
      if (PAN_SHAPE.test(fixed)) found.push({ pan: fixed, words });
    }
  }
  // Prefer the cleanest candidates (fewest joined words): joined name words must not tie a real PAN.
  const fewest = Math.min(...found.map((f) => f.words));
  const candidates = found.filter((f) => f.words === fewest).map((f) => f.pan);
  return { looksLikeCard, value: pickMajority(candidates), masked: false, candidates };
}

const AADHAAR_MASK = /[X*]{4}[ .-]?[X*]{4}[ .-]?\d{4}(?![ .-]?\d)/i;
/** Dates (01/01/1990, 01-01-1990, 01.01.1990) and a labelled birth year: removed so they don't join the number. */
const DATE = /(?<![A-Za-z0-9])\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?![A-Za-z0-9])/g;
const BIRTH_YEAR = /(?:\bYOB\b|\bBIRTH\b|\bDOB\b|जन्म)[^0-9;\n]{0,12}\d{4}(?!\d)/gi;
/** A digit group as OCR gives it: digits, with O/o→0, I/l→1, S→5, B→8 swaps inside. */
const GROUP = /(?<![A-Za-z0-9])[0-9OoIlSB]+(?![A-Za-z0-9])/g;
const TO_AADHAAR_DIGIT: Record<string, string> = { O: '0', o: '0', I: '1', l: '1', S: '5', B: '8' };
/** What may sit between two groups of one number: a space, dot or hyphen. */
const GROUP_GAP = /^\s*[.-]?\s*$/;

/** Runs of neighbouring digit groups on one line, e.g. [['2341','2341','2346'], ['9134', …]]. */
function digitRuns(line: string): string[][] {
  const clean = line.replace(DATE, ' ; ').replace(BIRTH_YEAR, ' ; ');
  const runs: string[][] = [];
  let run: string[] = [];
  let end = -1;
  for (const m of clean.matchAll(GROUP)) {
    const raw = m[0];
    const digits = raw.replace(/\D/g, '').length;
    // A group must be mostly real digits ("BOSS" is a word, "2O41" is a number).
    if (digits * 2 < raw.length) { if (run.length) runs.push(run); run = []; end = -1; continue; }
    const g = [...raw].map((c) => TO_AADHAAR_DIGIT[c] ?? c).join('');
    const start = m.index ?? 0;
    if (run.length && GROUP_GAP.test(clean.slice(end, start)) && clean.slice(end, start).length > 0) run.push(g);
    else { if (run.length) runs.push(run); run = [g]; }
    end = start + raw.length;
  }
  if (run.length) runs.push(run);
  return runs;
}

/** 12-digit numbers in a run: one 12-digit group, or three 4-digit groups not part of a 4×4 (16-digit VID). */
function aadhaarInRun(run: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < run.length; i++) {
    if (run[i]!.length === 12) out.push(run[i]!);
    const four = (k: number) => run[k]?.length === 4;
    if (four(i) && four(i + 1) && four(i + 2) && !four(i - 1) && !four(i + 3)) {
      out.push(run[i]! + run[i + 1]! + run[i + 2]!);
    }
  }
  return out;
}

export function parseAadhaarText(text: string): CardParse {
  const looksLikeCard = AADHAAR_KEYWORDS.test(text) && AADHAAR_CUES.test(text);
  const candidates: string[] = [];
  let maskSeen = false;
  // VID lines are not skipped: OCR can merge the VID and the Aadhaar onto one line; the 16-digit VID
  // itself is excluded by aadhaarInRun.
  for (const line of text.split(/\r?\n/)) {
    if (AADHAAR_MASK.test(line)) maskSeen = true;
    for (const run of digitRuns(line)) {
      for (const v of aadhaarInRun(run)) {
        if (/^[2-9]\d{11}$/.test(v) && verhoeffValid(v)) candidates.push(v);
      }
    }
  }
  return { looksLikeCard, value: pickMajority(candidates), masked: maskSeen && candidates.length === 0, candidates };
}

/** Uppercase, Latin letters only (anything else becomes a space), spaces collapsed, split into words. */
function nameWords(s: string): string[] {
  return s.toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** True when a and b differ by at most one insert, delete or change. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Does the name the user entered appear on the card? Every last-name word AND the first word of
 * the first name must appear as a whole word in the OCR text (any pass). Words of 5+ letters may
 * differ by one letter (OCR typos). Nothing to compare → false.
 */
export function nameOnCard(texts: string[], first: string, last: string): boolean {
  const firstWord = nameWords(first)[0];
  const needed = [...(firstWord ? [firstWord] : []), ...nameWords(last)];
  if (needed.length === 0) return false;
  const cardWords = new Set(texts.filter((t) => typeof t === 'string').flatMap(nameWords));
  return needed.every((w) => cardWords.has(w) || (w.length >= 5 && [...cardWords].some((c) => withinOneEdit(w, c))));
}
