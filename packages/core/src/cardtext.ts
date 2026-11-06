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
/**
 * Not the card: an income-tax return / acknowledgement, or a letter or email about the PAN
 * ("Dear …", "Your PAN … linked", "Sir/Madam"). These have the PAN words and the PAN too.
 */
const PAN_REJECT = new RegExp([
  /ACKNOWLEDG(?:E)?MENT|ASSESSMENT\s*YEAR|\bITR\b/.source,
  /\bDEAR\b|\bLINKED\b|\bYOUR\s+PAN\b|\bSIR\s*\/\s*MADAM\b/.source,
  // Form 16 / TDS certificate
  /\bFORM\s*(?:NO\.?\s*)?16\b|\bTDS\b/.source,
  // PAN–Aadhaar link status pages
  /\bLINK\s+SUCCESSFUL|\bLINK\s+AADHAA?R\b|\bSTATUS\b/.source,
].join('|'), 'i');
/** UIDAI letters and PAN–Aadhaar link pages: have the Aadhaar words and number, but are not the card. */
const AADHAAR_REJECT = /\bDEAR\b|\bRESIDENT\b|\bYOUR\s+AADHAA?R\s+HAS\s+BEEN\b|\bLINK\s+SUCCESSFUL|\bLINK\s+AADHAA?R\b/i;
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

/** PAN-shaped tokens of one line, OCR swaps fixed (all-digit runs never count). */
function pansInLine(line: string): { pan: string; words: number }[] {
  const out: { pan: string; words: number }[] = [];
  for (const { token, words } of panTokens(line)) {
    if (/^\d+$/.test(token)) continue; // an all-digit run (phone, account no.) is never a PAN
    const fixed = fixPanSwaps(token);
    if (PAN_SHAPE.test(fixed)) out.push({ pan: fixed, words });
  }
  return out;
}

/** Pre-2017 unlabelled PAN card: "GOVT. OF INDIA" and a dd/mm/yyyy birth date next to the PAN words. */
const PAN_OLD_GOVT = /\bGOVT\.?\s*OF\s*INDIA\b/i;
const FULL_DATE = /(?<!\d)\d{2}[/.-]\d{2}[/.-]\d{4}(?!\d)/;

export function parsePanText(text: string): CardParse {
  const found = text.split(/\r?\n/).flatMap(pansInLine);
  const oldLayout = PAN_OLD_GOVT.test(text) && FULL_DATE.test(text) && found.length > 0;
  const looksLikeCard = PAN_KEYWORDS.test(text) && (PAN_CUES.test(text) || oldLayout) && !PAN_REJECT.test(text);
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
  const looksLikeCard = AADHAAR_KEYWORDS.test(text) && AADHAAR_CUES.test(text) && !AADHAAR_REJECT.test(text);
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

/** OCR digit-for-letter swaps inside a name word (a digit in a name is always an OCR misread). */
const NAME_DIGIT: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B' };
const fixNameDigits = (w: string) => w.replace(/[0158]/g, (d) => NAME_DIGIT[d]!);
/**
 * OCR-confusable form of a word: digit swaps, then L→I, RN→M, VV→W. Two words that differ only by
 * these OCR confusions get the same form; a real different letter (RAKESH / RAJESH) never does.
 */
const confusableForm = (w: string) => fixNameDigits(w).replace(/L/g, 'I').replace(/RN/g, 'M').replace(/VV/g, 'W');

/**
 * Words printed on every card (issuer header, labels, gender). Never counted as name words, so
 * e.g. a typed "Indra" can't match the printed "INDIA".
 */
const NOT_NAME_WORDS = new Set([
  'INDIA', 'GOVERNMENT', 'GOVT', 'OF', 'INCOME', 'TAX', 'DEPARTMENT', 'PERMANENT', 'ACCOUNT', 'NUMBER', 'CARD',
  'UNIQUE', 'IDENTIFICATION', 'AUTHORITY', 'AADHAAR', 'AADHAR', 'MALE', 'FEMALE', 'DOB', 'YOB', 'DATE', 'BIRTH',
  'YEAR', 'NAME', 'FATHER', 'FATHERS', 'SIGNATURE', 'ENROLMENT', 'ENROLLMENT', 'NO', 'VID', 'TO', 'ADDRESS',
]);

/**
 * Candidate name words of one card line: Latin words (digits kept, fixed to letters, since OCR
 * reads "SANA" as "5ANA"), minus all-digit tokens and the printed card words.
 */
const lineNameWords = (line: string) =>
  line.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !/^\d+$/.test(w))
    .map(fixNameDigits)
    .filter((w) => !NOT_NAME_WORDS.has(w));

/**
 * A line that starts someone else's details: father, husband, S/O, W/O, D/O, C/O (also as OCR
 * reads them: "SO", "S1O", "S O", "S/0", "W|O", "C 0"), or the address.
 */
const RELATION_LINE = new RegExp([
  /\bFATHER|\bHUSBAND|\bGUARDIAN|\b(?:SON|WIFE|DAUGHTER|CARE)\s+OF\b|\bADDRESS\b|पिता|पति|पता/.source,
  // S/O, S.O, S:O, S-O, 5/O, $/O, S/0, W|O, D\O, C/O … ("D.O.B" is a birth date, not a relation)
  /(?<![A-Za-z0-9])[SWDC5$]\s*[/\\|.:-]\s*[O0](?![A-Za-z0-9])(?![.\s]*B\b)/.source,
].join('|'), 'i');
/** OCR forms of S/O … C/O without a clear slash; capital first letter only, so "so" / "do" in prose don't count. */
const RELATION_SHORT = /(?<![A-Za-z0-9])[SWDC]\s*[|1lI]?\s*[O0o](?![A-Za-z0-9])/;
/** S/O read with digits and no slash ("5 0", "50", "$ O"), only at the start of a line (so an address number never counts). */
const RELATION_DIGIT = /^\s*[5$]\s*[|1lI]?\s*[O0o](?![A-Za-z0-9])/;
const isRelationLine = (line: string) => RELATION_LINE.test(line) || RELATION_SHORT.test(line) || RELATION_DIGIT.test(line);
/** PAN lines at or after which the holder's name can no longer appear (father's name, date of birth). */
const PAN_STOP_LINE = /\bFATHER|पिता|\bDATE\s*OF\s*BIRTH\b|\bDOB\b|जन्म/i;
/** PAN issuer header lines; the holder's name is under the first one. */
const PAN_HEADER_LINE = /INCOME\s*TAX\s*DEPARTMENT|PERMANENT\s*ACCOUNT\s*NUMBER|आयकर\s*विभाग/i;
/** Aadhaar issuer header lines. */
const AADHAAR_HEADER_LINE = /GOVERNMENT\s*OF\s*INDIA|UNIQUE\s*IDENTIFICATION\s*AUTHORITY|भारत\s*सरकार/i;
/** The holder's "Name" label (not "Father's Name"). */
const NAME_LABEL = /\bNAME\b|नाम/i;

/**
 * A line that can be the holder's name: no digit run (dates, numbers; a single OCR digit inside a
 * word is allowed), not a stop or relation line, has a name word.
 */
const nameLike = (line: string) =>
  !/\d{2,}/.test(line) && !PAN_STOP_LINE.test(line) && !isRelationLine(line) && lineNameWords(line).length > 0;

/** A label-only line ("Name", "Father's Name", "Date of Birth"): a label and no name words. */
const labelOnly = (line: string) =>
  (NAME_LABEL.test(line) || PAN_STOP_LINE.test(line)) && lineNameWords(line).filter((w) => w.length > 1).length === 0;

/**
 * PAN holder name words from one OCR text:
 * - "Name: X" on one line → X; a "Name" label followed by its value line → that line.
 * - Labels first ("Name", then "Father's Name", then the two values): the first value line, but
 *   only when there are at least as many value lines as name labels (an OCR pass that lost the
 *   holder's line must not hand the father's line over as the holder's).
 * - No "Name" label: the first name-like line under the issuer header.
 * Never a word from the "Father's Name" value line or below the date of birth.
 */
function panHolderWords(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const label = lines.findIndex((l) => NAME_LABEL.test(l) && !PAN_STOP_LINE.test(l) && !isRelationLine(l));
  if (label >= 0) {
    const after = lines[label]!.replace(/^.*?(?:\bNAME\b|नाम)\s*[:.-]?/i, '');
    // "नाम / Name": the English label after the Hindi one is still part of the label.
    const rest = after.replace(/^.*\bNAME\b\s*[:.-]?/i, '');
    if (nameLike(rest)) return lineNameWords(rest);
    let i = label + 1;
    // Labels-first layout: skip the label-only lines, counting the name labels among them.
    let nameLabels = 1;
    let sawFatherLabel = false;
    while (i < lines.length && labelOnly(lines[i]!)) {
      if (/\bFATHER|पिता/i.test(lines[i]!)) { sawFatherLabel = true; nameLabels++; }
      i++;
    }
    if (!sawFatherLabel) {
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        if (PAN_STOP_LINE.test(l) || isRelationLine(l)) return [];
        if (nameLike(l)) return lineNameWords(l);
      }
      return [];
    }
    const values: string[][] = [];
    for (; i < lines.length && values.length < nameLabels; i++) {
      const l = lines[i]!;
      if (labelOnly(l)) continue;
      if (/\d{2,}/.test(l)) break; // date of birth / number: the name values are over
      if (nameLike(l)) values.push(lineNameWords(l));
    }
    return values.length >= nameLabels ? values[0]! : [];
  }
  // No "Name" label (pre-2017 card): the holder's name, then the father's name, then the date of
  // birth. Both name lines must be there before the date, and the first is the holder's: with
  // only one (a covered line, or an OCR pass that dropped one), it may be the father's, so [].
  // A "Father's Name" label (or a relation line) right under one name line marks that line as the
  // holder's. A date / "Date of Birth" line needs two name lines above it (the "Name" and
  // "Father's Name" labels may be the covered or dropped lines too).
  const header = lines.findIndex((l) => PAN_HEADER_LINE.test(l));
  const names: string[][] = [];
  for (let i = header + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (FULL_DATE.test(l) || /\bDATE\s*OF\s*BIRTH\b|\bDOB\b|जन्म/i.test(l)) return names.length >= 2 ? names[0]! : [];
    if (PAN_STOP_LINE.test(l) || isRelationLine(l)) return names[0] ?? [];
    if (nameLike(l)) names.push(lineNameWords(l));
  }
  return [];
}

/** A date-of-birth / year-of-birth line with its value (a label alone, with no digits, doesn't count). */
const BIRTH_LABEL = /\bDOB\b|\bD\.O\.B\b|\bDATE\s*OF\s*BIRTH\b|\bYEAR\s*OF\s*BIRTH\b|\bYOB\b|जन्म/i;
const isBirthLine = (line: string) => BIRTH_LABEL.test(line) && /\d{4}/.test(line);
/** Gender lines; English and Hindi are counted apart ("पुरुष / MALE" may be one line or two). */
const GENDER_EN = /\bMALE\b|\bFEMALE\b|\bTRANSGENDER\b/i;
const GENDER_HI = /पुरुष|महिला|ट्रांसजेंडर/;
const isBirthOrGenderLine = (line: string) => isBirthLine(line) || GENDER_EN.test(line) || GENDER_HI.test(line);

const isValidAadhaar = (v: string) => /^[2-9]\d{11}$/.test(v) && verhoeffValid(v);
/** Index of the first line holding a valid Aadhaar number; lines.length when none. */
function firstAadhaarLine(lines: string[]): number {
  const i = lines.findIndex((l) => digitRuns(l).flatMap(aadhaarInRun).some(isValidAadhaar));
  return i < 0 ? lines.length : i;
}

/**
 * Aadhaar holder name words from one OCR text.
 * - Card layout (a DOB / gender line above the number): the name-like line directly above the
 *   number's own DOB / gender lines; another DOB / gender line, a header or a relation line first → [].
 * - Otherwise (e.g. the e-Aadhaar letter part): the first name-like line (not an issuer header)
 *   before the first S/O, W/O, D/O, C/O, father/husband or address line.
 */
function aadhaarHolderWords(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // Card layout (name, DOB, gender, number): the name is taken only from the lines directly above
  // the number's own DOB / gender lines, so a name from another card higher up never counts.
  const n = firstAadhaarLine(lines);
  let g = -1;
  for (let i = n - 1; i >= 0 && g < 0; i--) if (isBirthOrGenderLine(lines[i]!)) g = i;
  let from = 0;
  let to = lines.length;
  if (g >= 0) {
    // this card's own DOB / gender lines (one block directly above the number)
    // (at most one DOB, one English and one Hindi gender line: a repeat belongs to another card)
    const kinds = (l: string) => [isBirthLine(l) && 'b', GENDER_EN.test(l) && 'e', GENDER_HI.test(l) && 'h'].filter(Boolean);
    const seen = new Set(kinds(lines[g]!));
    let b = g;
    while (b > 0 && isBirthOrGenderLine(lines[b - 1]!)) {
      const k = kinds(lines[b - 1]!);
      if (k.some((x) => seen.has(x))) break;
      k.forEach((x) => seen.add(x));
      b--;
    }
    // the name sits between the previous card's DOB / gender line (if any) and this block
    let p = b - 1;
    while (p >= 0 && !isBirthOrGenderLine(lines[p]!)) p--;
    from = p + 1;
    to = b;
  }
  for (const line of lines.slice(from, to)) {
    if (isRelationLine(line)) return [];
    if (AADHAAR_HEADER_LINE.test(line)) continue;
    if (nameLike(line)) return lineNameWords(line);
  }
  return [];
}

/** Top PAN header (start of one PAN card). "Permanent Account Number" sits above the number on old cards, so it is not a start. */
const PAN_TOP_HEADER = /INCOME\s*TAX\s*DEPARTMENT|आयकर\s*विभाग/i;

/** Indexes of the lines of `text` that hold `value` (OCR swaps fixed). */
function numberLines(lines: string[], field: 'pan' | 'aadhaar', value: string): number[] {
  const out: number[] = [];
  lines.forEach((l, i) => {
    const vs = field === 'pan' ? pansInLine(l).map((p) => p.pan) : digitRuns(l).flatMap(aadhaarInRun);
    if (vs.includes(value)) out.push(i);
  });
  return out;
}

/**
 * The part of one OCR text that belongs to the card holding `value`; null when the text doesn't
 * hold it. PAN: from the top header above the number to the next top header. Aadhaar: from the
 * issuer header above the number down to the number (the name is printed above it).
 */
export function cardBlock(text: string, field: 'pan' | 'aadhaar', value: string): string | null {
  const lines = text.split(/\r?\n/);
  const n = numberLines(lines, field, value)[0];
  if (n === undefined) return null;
  const header = field === 'pan' ? PAN_TOP_HEADER : AADHAAR_HEADER_LINE;
  let start = 0;
  for (let i = n; i >= 0; i--) if (header.test(lines[i]!)) { start = i; break; }
  let end = n + 1;
  if (field === 'pan') {
    end = lines.length;
    for (let i = n + 1; i < lines.length; i++) if (PAN_TOP_HEADER.test(lines[i]!)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, 'gi')) ?? []).length;

/**
 * More than one card in one OCR text (e.g. two cards in one photo): a PAN header word twice, two
 * holder "Name" labels, or two different valid numbers of that card type. Aadhaar keywords and
 * "Government of India" are not counted: one e-Aadhaar prints them several times.
 */
export function hasMultipleCards(text: string, field: 'pan' | 'aadhaar'): boolean {
  if (field === 'pan' && [/INCOME\s*TAX\s*DEPARTMENT/, /PERMANENT\s*ACCOUNT\s*NUMBER/, /आयकर\s*विभाग/].some((re) => count(re, text) > 1)) {
    return true;
  }
  const lines = text.split(/\r?\n/);
  const holderLabels = lines.filter((l) => !PAN_STOP_LINE.test(l) && !isRelationLine(l));
  if (holderLabels.filter((l) => /\bNAME\b/i.test(l)).length > 1 || holderLabels.filter((l) => /नाम/.test(l)).length > 1) return true;
  if (field === 'pan') {
    // a second date of birth (labelled, or the bare date of a pre-2017 card); issue / print dates don't count
    if (lines.filter((l) => (FULL_DATE.test(l) || isBirthLine(l)) && !/ISSUE|DOWNLOAD|GENERAT|PRINT/i.test(l)).length > 1) return true;
  } else {
    // a second DOB / year-of-birth line or a second gender line
    if (lines.filter(isBirthLine).length > 1) return true;
    if (lines.filter((l) => GENDER_EN.test(l)).length > 1 || lines.filter((l) => GENDER_HI.test(l)).length > 1) return true;
    // two holder-name lines before the number with no relation line between them (a covered header
    // can't hide a second card); after the first relation line come the address lines
    const n = firstAadhaarLine(lines);
    let names = 0;
    for (let i = 0; i < n; i++) {
      const l = lines[i]!;
      if (isRelationLine(l)) break;
      if (!AADHAAR_HEADER_LINE.test(l) && nameLike(l) && lineNameWords(l).some((w) => w.length >= 3)) names++;
    }
    if (names > 1) return true;
  }
  const parse = field === 'pan' ? parsePanText(text) : parseAadhaarText(text);
  return new Set(parse.candidates).size > 1;
}

/**
 * One holder name (ordered words) against the typed name: true / false, or null when the card
 * shows only an initial for the first name ("N K SANA") that agrees with the typed name.
 */
/**
 * First-name words that many relatives share (Mohammed Amir / Mohammed Asif): typed alone, they
 * can't tell the holder from a sibling when the card has more words before the surname.
 */
const SHARED_PREFIXES = new Set([
  'MOHAMMED', 'MOHAMMAD', 'MOHAMED', 'MOHAMAD', 'MUHAMMAD', 'MUHAMMED', 'MOHD', 'MD',
  'SYED', 'SAYYED', 'SAIYED', 'SHAIK', 'SHAIKH', 'SHEIK', 'SHEIKH', 'SK', 'SRI', 'SHRI', 'SREE', 'SHREE',
]);

function holderMatch(holder: string[], firstWords: string[], lastWords: string[]): boolean | null {
  if (holder.length < firstWords.length + lastWords.length) return false;
  const same = (a: string, b: string) => a === b || confusableForm(a) === confusableForm(b);
  // the surname must be the holder's final word(s)
  const tail = holder.slice(-lastWords.length);
  if (!lastWords.every((w, i) => same(w, tail[i]!))) return false;
  const head = holder[0]!;
  if (head.length === 1) return confusableForm(head) === confusableForm(firstWords[0]![0]!) ? null : false;
  // every typed first-name word must be the holder's leading words, in order (a father's /
  // husband's first name in the middle never counts, nor does only the first of two typed words)
  if (!firstWords.every((w, i) => same(w, holder[i]!))) return false;
  // only a shared prefix typed, and the card has more words before the surname: a person checks it
  const more = holder.length - lastWords.length > firstWords.length;
  if (firstWords.length === 1 && SHARED_PREFIXES.has(fixNameDigits(firstWords[0]!)) && more) return null;
  return true;
}

/**
 * Does the name the user entered match the card holder's name? Only the holder's name line counts
 * (see panHolderWords / aadhaarHolderWords), never the father's / husband's name or the address.
 * - Every typed first-name word must be the holder's leading words, in order; a one-letter typed
 *   first name is never a match (false). A typed first name that is only a shared prefix
 *   (Mohammed, Mohd, Md, Syed, Shaik, Sk, Sri, Shri) on a card with more words before the surname
 *   gives null (review).
 * - Every typed last-name word must be among the holder's last words, in order.
 * - No general typo allowance (siblings like RAKESH / RAJESH differ by one letter): words are equal
 *   exactly or after OCR-confusable mapping (5→S, 0→O, 1/I/L→I, 8→B, RN→M, VV→W).
 * - Each OCR pass is compared on its own: true when any pass matches; else null when a pass shows
 *   only an initial first name that agrees ("N K SANA": not confirmed, goes to review); else false.
 * Returns null ("not checked") when the typed first or last name has no Latin letters (e.g. typed
 * in an Indian script): the card text is read in Latin letters only, so it can't be compared.
 * A null from a read that was given a name must go to review (kyc checkOutcome does this).
 * `field` picks the card layout; without it, a text with the PAN header words is read as a PAN.
 */
export function nameOnCard(texts: string[], first: string, last: string, field?: 'pan' | 'aadhaar'): boolean | null {
  const firstWords = nameWords(first);
  const lastWords = nameWords(last);
  if (firstWords.length === 0 || lastWords.length === 0) return null;
  if (firstWords[0]!.length === 1) return false;
  const holder = (t: string) =>
    (field ?? (PAN_KEYWORDS.test(t) ? 'pan' : 'aadhaar')) === 'pan' ? panHolderWords(t) : aadhaarHolderWords(t);
  const results = texts
    .filter((t) => typeof t === 'string')
    .map(holder)
    .filter((h) => h.length > 0)
    .map((h) => holderMatch(h, firstWords, lastWords));
  // no pass showed a holder name line (e.g. a covered or dropped line): not checked → review
  if (results.length === 0) return null;
  if (results.includes(true)) return true;
  return results.includes(null) ? null : false;
}
