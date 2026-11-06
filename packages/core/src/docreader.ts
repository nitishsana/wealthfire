// Document reader slot. v1 ships DemoDocumentReader, which reads nothing and returns a number
// based on the picked demo mode. A real partner reader (Digio / HyperVerge OCR) needs a backend
// that uploads the file over HTTPS and returns only the number. Files are never stored or logged.
import type { DocReaderId, KycField } from './types';
import { normalizeAadhaar, normalizePan, validateAadhaar, validatePan, verhoeffCheckDigit } from './onboarding';
import { cardBlock, hasMultipleCards, nameOnCard, parseAadhaarText, parsePanText, pickMajority } from './cardtext';

export type DocKind = 'selfie' | 'aadhaar' | 'pan';
export type DocMime = 'image/jpeg' | 'image/png' | 'application/pdf';

export interface DocFile {
  kind: DocKind;
  name: string;
  mime: DocMime;
  /** bytes */
  size: number;
  /** Opaque handle the app can read: blob: URL on web, file:// cache URI on phones. Never stored. */
  uri: string;
}

export interface ReadOptions {
  /** true on a re-read */
  strict: boolean;
  /** Demo reader only: the number to compare against. A real reader must never trust it. */
  expected?: string;
  /** Password for a locked PDF, typed by the user for this read only. Never stored or logged. */
  password?: string;
  /** The name the user entered; the on-device reader checks it against the card text. */
  name?: { first: string; last: string };
}

export type ReadResult =
  /**
   * nameMatch: is the entered name the card holder's name? null = not checked: no name was given,
   * or the typed first / last name has no Latin letters (show DOC_MESSAGES.nameNotChecked).
   */
  | { ok: true; value: string; nameMatch: boolean | null }
  | { ok: false; reason: 'unreadable' | 'invalid' | 'network' | 'locked'; message: string };

export interface DocumentReader {
  id: DocReaderId;
  isDemo: boolean;
  read(doc: DocFile, field: KycField, opts: ReadOptions): Promise<ReadResult>;
}

export const MAX_DOC_BYTES = 10 * 1024 * 1024;

export const DOC_MESSAGES = {
  selfieFile: 'Use a JPG or PNG photo under 10 MB.',
  cardFile: 'Use a JPG, PNG or PDF under 10 MB.',
  couldNotReadFile: 'Could not read that file.',
  couldNotReadDocs: 'Could not read your documents. Check your connection and try again.',
  noCamera: 'No camera found. Upload a photo instead.',
  cameraReason: 'Wealthfire needs your camera to take your KYC selfie.',
  cameraDenied: 'Allow camera access, or choose a file instead.',
  uploadIntro: 'Add all three to finish your KYC.',
  matchLabel: '✅ Match',
  mismatchLabel: "❌ Doesn't match",
  cameraInUse: 'Your camera is in use by another app. Close it and try again.',
  waitingForCamera: 'Waiting for camera permission…',
  notPan: "This doesn't look like a PAN card. Upload your PAN card.",
  notAadhaar: "This doesn't look like an Aadhaar card. Upload your Aadhaar card.",
  maskedAadhaar: 'This Aadhaar is masked. Upload the full Aadhaar or the e-Aadhaar PDF.',
  readerUnavailable: "Document reading isn't available in this app build.",
  nameMatches: 'Name matches',
  nameMismatch: "The name on this card doesn't match the name you entered.",
  /** Shown with nameMismatch: the check goes to manual review. */
  nameReview: "We'll check this by hand.",
  /** Check numbers summary when both numbers match but a card's name didn't (instead of "Both numbers match…"). */
  numbersMatchNameReview: "Both numbers match your documents, but a name doesn't. We'll check this by hand.",
  /** nameMatch === null after a read with a name (e.g. the name was typed in an Indian script). */
  nameNotChecked: "We couldn't check the name on this card.",
  /** More than one card in one photo / file. */
  oneCardOnly: 'Upload a photo with just one card.',
  companyPan: 'This is a company or firm PAN. Upload your personal PAN card.',
  pdfLocked: "This PDF has a password. Enter it to read the file. It isn't saved.",
  pdfLockedPhone: 'This PDF has a password. Remove the password or upload a photo of the card instead.',
  wrongPdfPassword: "That password didn't open the PDF. Try again.",
  sameFile: 'You uploaded the same file for both cards. Upload your Aadhaar and PAN separately.',
  noRereadsLeft: 'No re-checks left for this card.',
  verifiedNumberLabel: 'Verified number',
  /** Done screen after the device checks pass (status 'pre-verified'). */
  donePreVerified: 'Your documents match. A final KYC check confirms your account before you can invest.',
  /** Done screen after a final KYC approval (status 'verified'). Same text on web and phones. */
  doneVerified: 'Your final KYC check is complete. Your account is verified.',
  /** Hand-check fallback (canSendForHandCheck): button that dispatches `send-for-hand-check`. */
  handCheckButton: 'Send my documents for a hand check',
  /** Shown above handCheckButton. */
  handCheckNote: "We couldn't read your card. Our team can check your documents by hand instead.",
  unreadable: (field: KycField) =>
    `We couldn't read your ${field === 'pan' ? 'PAN' : 'Aadhaar'} card. Upload a clearer photo or PDF.`,
} as const;

/** Error text, or null when the file type and size are fine for the slot. */
export function validateDocFile(f: Pick<DocFile, 'kind' | 'mime' | 'size'>): string | null {
  const images = f.mime === 'image/jpeg' || f.mime === 'image/png';
  const sizeOk = Number.isFinite(f.size) && f.size > 0 && f.size <= MAX_DOC_BYTES;
  if (f.kind === 'selfie') return images && sizeOk ? null : DOC_MESSAGES.selfieFile;
  return (images || f.mime === 'application/pdf') && sizeOk ? null : DOC_MESSAGES.cardFile;
}

/** True when two picked files look like the same file (same name, size and type), e.g. one file in both card slots. */
export function sameDocument(
  a: Pick<DocFile, 'name' | 'size' | 'mime'>,
  b: Pick<DocFile, 'name' | 'size' | 'mime'>,
): boolean {
  return a.name === b.name && a.size === b.size && a.mime === b.mime;
}

export type DemoReadMode = 'match' | 'misread' | 'different' | 'unreadable';

const OTHER = { pan: ['AAAPZ9999Z', 'ABCPE1234F'], aadhaar: ['499118665246', '234123412346'] } as const;

const norm = (field: KycField, v: string) => (field === 'pan' ? normalizePan(v) : normalizeAadhaar(v));
const valid = (field: KycField, v: string) => (field === 'pan' ? validatePan(v) : validateAadhaar(v)) === null;

/** A fixed valid number that is never the expected one. */
function otherNumber(field: KycField, expected: string): string {
  const [a, b] = OTHER[field];
  return expected === a ? b : a;
}

const bump = (d: string) => String((Number(d) + 1) % 10);

/** The expected number with one character changed, still a valid PAN / Verhoeff-valid Aadhaar. */
function misread(field: KycField, expected: string): string {
  if (field === 'pan') return expected.slice(0, 5) + bump(expected[5]!) + expected.slice(6);
  const first11 = expected.slice(0, 5) + bump(expected[5]!) + expected.slice(6, 11);
  return first11 + verhoeffCheckDigit(first11);
}

/** On-device stand-in for a real document reader. Never sends a file anywhere. */
export class DemoDocumentReader implements DocumentReader {
  readonly id: DocReaderId = 'demo';
  readonly isDemo = true;

  constructor(public mode: DemoReadMode = 'match') {}

  async read(doc: DocFile, field: KycField, opts: ReadOptions): Promise<ReadResult> {
    const bad = validateDocFile(doc);
    if (bad) return { ok: false, reason: 'invalid', message: bad };
    if (this.mode === 'unreadable') return { ok: false, reason: 'unreadable', message: DOC_MESSAGES.unreadable(field) };
    const expected = norm(field, opts.expected ?? '');
    // Without a valid expected number there is nothing to echo: act as 'different'.
    if (!valid(field, expected) || this.mode === 'different') return { ok: true, value: otherNumber(field, expected), nameMatch: false };
    if (this.mode === 'misread' && !opts.strict) return { ok: true, value: misread(field, expected), nameMatch: true };
    return { ok: true, value: expected, nameMatch: true };
  }
}

/**
 * OCR text engine supplied by each platform (web: Tesseract + pdf.js, phones: ML Kit).
 * Returns one text per pass; strict (re-read) runs extra passes (scaled, threshold, rotated).
 */
export type TextExtractor = (doc: DocFile, opts: { strict: boolean; password?: string }) => Promise<string[]>;

/** Error codes a TextExtractor may throw (as `Error` with a `code` property) for a password-protected PDF. */
export const PDF_LOCKED_CODE = 'pdf-locked';
export const PDF_BAD_PASSWORD_CODE = 'pdf-bad-password';
/** Error codes a TextExtractor may throw when the OCR engine files couldn't load, or the network failed. */
export const OCR_LOAD_CODE = 'ocr-load';
export const NETWORK_CODE = 'network';

function errorCode(e: unknown): unknown {
  return typeof e === 'object' && e !== null && 'code' in e ? (e as { code: unknown }).code : undefined;
}

/**
 * Reads the card on the device: the platform extracts text, core parses it.
 * Never uses `opts.expected`. A document never "matches" without being read.
 */
export function createOnDeviceReader(extract: TextExtractor): DocumentReader {
  return {
    id: 'ondevice',
    isDemo: false,
    async read(doc, field, opts) {
      const bad = validateDocFile(doc);
      if (bad) return { ok: false, reason: 'invalid', message: bad };
      const unreadable: ReadResult = { ok: false, reason: 'unreadable', message: DOC_MESSAGES.unreadable(field) };
      let texts: string[];
      try {
        texts = await extract(doc, opts.password !== undefined ? { strict: opts.strict, password: opts.password } : { strict: opts.strict });
      } catch (e) {
        const code = errorCode(e);
        if (code === PDF_LOCKED_CODE) return { ok: false, reason: 'locked', message: DOC_MESSAGES.pdfLocked };
        if (code === PDF_BAD_PASSWORD_CODE) return { ok: false, reason: 'locked', message: DOC_MESSAGES.wrongPdfPassword };
        // The engine didn't load (offline, wrong asset path, blocked): not the photo's fault.
        if (code === OCR_LOAD_CODE || code === NETWORK_CODE) return { ok: false, reason: 'network', message: DOC_MESSAGES.couldNotReadDocs };
        return unreadable;
      }
      const parse = field === 'pan' ? parsePanText : parseAadhaarText;
      const parses = (Array.isArray(texts) ? texts : []).filter((t) => typeof t === 'string').map(parse);
      if (!parses.some((p) => p.looksLikeCard)) {
        return { ok: false, reason: 'invalid', message: field === 'pan' ? DOC_MESSAGES.notPan : DOC_MESSAGES.notAadhaar };
      }
      // One card per photo: a number from one card and a name from another must never pair up.
      const allTexts = (Array.isArray(texts) ? texts : []).filter((t): t is string => typeof t === 'string');
      if (allTexts.some((t) => hasMultipleCards(t, field))) {
        return { ok: false, reason: 'unreadable', message: DOC_MESSAGES.oneCardOnly };
      }
      // Several different valid numbers: the most frequent across passes wins, a tie is unreadable.
      const value = pickMajority(parses.flatMap((p) => p.candidates));
      // 4th PAN character is the holder type; only 'P' (person) is a personal PAN.
      if (value && field === 'pan' && value[3] !== 'P') {
        return { ok: false, reason: 'invalid', message: DOC_MESSAGES.companyPan };
      }
      if (value) {
        // The name is taken only from the card block that holds the picked number (passes without it don't count).
        const blocks = allTexts.map((t) => cardBlock(t, field, value)).filter((b): b is string => b !== null);
        const nameMatch = opts.name ? nameOnCard(blocks, opts.name.first, opts.name.last, field) : null;
        return { ok: true, value, nameMatch };
      }
      if (field === 'aadhaar' && parses.some((p) => p.masked)) {
        return { ok: false, reason: 'invalid', message: DOC_MESSAGES.maskedAadhaar };
      }
      return unreadable;
    },
  };
}

/** On-device reader without a text engine (e.g. native module missing): always fails, never a fake match. */
function unavailableReader(): DocumentReader {
  return {
    id: 'ondevice',
    isDemo: false,
    async read() {
      return { ok: false, reason: 'unreadable', message: DOC_MESSAGES.readerUnavailable };
    },
  };
}

/**
 * Single factory for the app's document reader.
 * undefined / '' / 'ondevice' → on-device reader (needs `extract`; without it every read fails
 * with DOC_MESSAGES.readerUnavailable). 'demo' → DemoDocumentReader (local dev launchers only).
 */
export function createDocumentReader(cfg: { reader?: string; apiUrl?: string; extract?: TextExtractor }): DocumentReader {
  const id = cfg.reader;
  if (id === undefined || id === '' || id === 'ondevice') {
    return cfg.extract ? createOnDeviceReader(cfg.extract) : unavailableReader();
  }
  if (id === 'demo') return new DemoDocumentReader();
  throw new Error(`Document reader "${id}" is not built yet`);
}

/**
 * Same as createDocumentReader but never throws: an unknown reader id falls back to the default
 * on-device reader (with `cfg.extract`; without it every read fails with readerUnavailable).
 */
export function createDocumentReaderSafe(cfg: { reader?: string; apiUrl?: string; extract?: TextExtractor }): DocumentReader {
  try {
    return createDocumentReader(cfg);
  } catch {
    return cfg.extract ? createOnDeviceReader(cfg.extract) : unavailableReader();
  }
}

/**
 * Does this read count toward the hand-check fallback (dispatch `read-failed`)? Every failed read
 * does, whatever the reason: unreadable, invalid (company PAN, not a card, masked Aadhaar), locked, network.
 */
export function countsAsFailedRead(r: ReadResult): boolean {
  return !r.ok;
}
