// Web text engine for the on-device document reader (design Part C3).
// Tesseract (self-hosted under <base>/ocr/, copied by scripts/copy-ocr-assets.mjs) reads a canvas;
// pdf.js renders page 1 of a PDF to that canvas first. Both load lazily on the first read.
// Privacy (C5): images and text stay in memory. OCR text is returned to the caller only; it is
// never stored, logged or sent anywhere.
import { OCR_LOAD_CODE, type DocFile, type TextExtractor } from '@wealthfire/core';
import type { Worker as TesseractWorker } from 'tesseract.js';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Longest side of the normal pass, in pixels. Large phone photos are scaled down to this. */
const BASE_MAX = 2000;
/** Longest side of the strict 2x pass. */
const SCALED_MAX = 4000;
const PDF_SCALE = 2;

type ProgressListener = (fraction: number) => void;
const listeners = new Set<ProgressListener>();

/**
 * Subscribe to reading progress, 0..1 for the document being read now (all its passes).
 * Returns an unsubscribe function.
 */
export function onOcrProgress(cb: ProgressListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(fraction: number): void {
  const f = Math.max(0, Math.min(1, fraction));
  for (const cb of listeners) {
    try {
      cb(f);
    } catch {
      // A listener's error must not break reading.
    }
  }
}

// Which pass of how many is running, so Tesseract's per-job progress maps to the whole document.
let passIndex = 0;
let passCount = 1;

const assetUrl = (path: string) => new URL(`${import.meta.env.BASE_URL}ocr/${path}`, window.location.href).href;

/**
 * Review bug 3: the OCR files (Tesseract worker/core/language, pdf.js module/worker) failed to load.
 * Code 'ocr-load' makes the core reader answer reason 'network' (couldNotReadDocs), not "upload a clearer photo".
 */
function ocrLoadError(cause: unknown): Error {
  return Object.assign(new Error(OCR_LOAD_CODE), { code: OCR_LOAD_CODE, cause });
}

/** pdf.js could not start its worker (it then tries a "fake worker", which also needs the worker file). */
function isPdfWorkerLoadError(err: unknown): boolean {
  const msg = err && typeof err === 'object' ? (err as { message?: unknown }).message : err;
  return typeof msg === 'string' && /fake worker|failed to fetch dynamically imported module|importing a module script failed/i.test(msg);
}

let workerPromise: Promise<TesseractWorker> | null = null;

/** One Tesseract worker for the page, created on first use and reused. */
function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    // Any failure here is loading the engine (module import, worker, core or language file), never the photo.
    workerPromise = import('tesseract.js')
      .then(({ createWorker, OEM }) =>
        createWorker('eng', OEM.LSTM_ONLY, {
          workerPath: assetUrl('worker.min.js'),
          workerBlobURL: false,
          corePath: assetUrl('core/'),
          langPath: assetUrl('lang'),
          gzip: true,
          logger: (m) => {
            if (m.status === 'recognizing text') emit((passIndex + m.progress) / passCount);
          },
        }),
      )
      .catch((err: unknown) => {
        workerPromise = null; // allow a retry on the next read
        throw ocrLoadError(err);
      });
  }
  return workerPromise;
}

/** Stops the Tesseract worker and frees its memory. Call when onboarding completes. Safe to call anytime. */
export async function terminateOcr(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Already gone or never started.
  }
}

// Reads run one at a time on the shared worker.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available');
  return ctx;
}

/** Copy of `src` resized so its longest side is at most `max` (times `scale`). */
function resized(src: HTMLCanvasElement, scale: number, max: number): HTMLCanvasElement {
  const factor = Math.min(scale, max / Math.max(src.width, src.height));
  const out = newCanvas(src.width * factor, src.height * factor);
  const ctx = ctx2d(out);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

async function imageToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  // EXIF orientation is applied, so phone photos come in upright.
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const c = newCanvas(bitmap.width, bitmap.height);
    ctx2d(c).drawImage(bitmap, 0, 0);
    return c;
  } finally {
    bitmap.close();
  }
}

/** Error with a `code` the core reader maps to reason 'locked' ('pdf-locked' / 'pdf-bad-password'). */
function pdfPasswordError(code: 'pdf-locked' | 'pdf-bad-password'): Error {
  return Object.assign(new Error(code), { code });
}

/** pdf.js rejects a locked PDF with a PasswordException (PasswordResponses NEED_PASSWORD / INCORRECT_PASSWORD). */
function asPasswordError(err: unknown, password: string | undefined): Error | null {
  if (!err || typeof err !== 'object' || (err as { name?: unknown }).name !== 'PasswordException') return null;
  // No password given -> locked. A password given and still refused -> wrong password.
  return pdfPasswordError(password ? 'pdf-bad-password' : 'pdf-locked');
}

/** Page 1 of a PDF on a canvas. `password` (e-Aadhaar / e-PAN) is used for this one open only, never kept. */
async function pdfToCanvas(blob: Blob, password: string | undefined): Promise<HTMLCanvasElement> {
  let pdfjs: typeof import('pdfjs-dist');
  try {
    pdfjs = await import('pdfjs-dist');
  } catch (err) {
    throw ocrLoadError(err);
  }
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    ...(password ? { password } : {}),
    // Self-hosted (scripts/copy-ocr-assets.mjs): image decoders for scanned PDFs and the standard fonts.
    wasmUrl: assetUrl('pdfjs/wasm/'),
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    // Review bug 12: character maps for PDFs whose fonts aren't embedded (otherwise they render without text).
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
  });
  try {
    let pdf;
    try {
      pdf = await task.promise;
    } catch (err) {
      throw asPasswordError(err, password) ?? (isPdfWorkerLoadError(err) ? ocrLoadError(err) : err);
    }
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const c = newCanvas(viewport.width, viewport.height);
    const ctx = ctx2d(c);
    ctx.fillStyle = '#fff'; // transparent PDF backgrounds read as black otherwise
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, viewport }).promise;
    return c;
  } finally {
    await task.destroy();
  }
}

/** Greyscale, then black/white at Otsu's threshold. */
function threshold(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = newCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const px = img.data;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < px.length; i += 4) {
    const y = Math.round(0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!);
    px[i] = y;
    hist[y]!++;
  }
  const total = px.length / 4;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]!;
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let level = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const between = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      level = t;
    }
  }
  for (let i = 0; i < px.length; i += 4) {
    const v = px[i]! > level ? 255 : 0;
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function rotated(src: HTMLCanvasElement, degrees: 90 | 180 | 270): HTMLCanvasElement {
  const swap = degrees !== 180;
  const out = newCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = ctx2d(out);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

function clear(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

async function extract(doc: DocFile, opts: { strict: boolean; password?: string }): Promise<string[]> {
  emit(0);
  const blob = await (await fetch(doc.uri)).blob();
  const source = doc.mime === 'application/pdf' ? await pdfToCanvas(blob, opts.password) : await imageToCanvas(blob);
  const base = resized(source, 1, BASE_MAX);
  if (base !== source) clear(source);

  // Normal: one pass. Strict (re-read): 2x scale, grey + threshold, and sideways/upside-down copies.
  const passes: Array<() => HTMLCanvasElement> = [() => base];
  if (opts.strict) {
    passes.push(
      () => resized(base, 2, SCALED_MAX),
      () => threshold(base),
      () => rotated(base, 90),
      () => rotated(base, 180),
      () => rotated(base, 270),
    );
  }

  const worker = await getWorker();
  const texts: string[] = [];
  passCount = passes.length;
  try {
    for (let i = 0; i < passes.length; i++) {
      passIndex = i;
      const canvas = passes[i]!();
      try {
        const { data } = await worker.recognize(canvas);
        texts.push(data.text ?? '');
      } finally {
        if (canvas !== base) clear(canvas);
      }
    }
  } finally {
    clear(base);
    passIndex = 0;
    passCount = 1;
  }
  emit(1);
  return texts;
}

/** On-device text extractor for createOnDeviceReader: one text per OCR pass. */
export const extractText: TextExtractor = (doc, opts) => serial(() => extract(doc, opts));
