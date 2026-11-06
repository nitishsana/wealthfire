// Phone text engine for the on-device document reader (design C4).
// ML Kit reads text from images; react-native-pdf-thumbnail renders PDF page 1 to an image first.
// Both are native modules: they exist only in a custom development build (`expo run:android` /
// `run:ios` or EAS), not in Expo Go. They are loaded with a guarded require, and when either is
// missing `ocrAvailable()` is false and `extractText` throws, so the reader can never fake a match.
// Privacy (C5): images and text stay in memory / the app cache; every temp image made here is
// deleted after the read, and OCR text is never stored or logged.
import { Image, NativeModules, TurboModuleRegistry } from 'react-native';
import { manipulateAsync, SaveFormat, type Action } from 'expo-image-manipulator';
import { deleteAsync } from 'expo-file-system/legacy';
import { PDF_LOCKED_CODE, type DocFile, type TextExtractor } from '@wealthfire/core';

interface MlKit { recognize(uri: string): Promise<{ text: string }> }
interface PdfThumb { generate(uri: string, page: number, quality: number): Promise<{ uri: string; width: number; height: number }> }

interface Engines { ml: MlKit; pdf: PdfThumb }

/** Longest side for the 2x pass, so a large photo never runs the phone out of memory. */
const MAX_SIDE = 4096;
const ROTATIONS = [90, 180, 270] as const;

/** react-native-pdf-thumbnail's error text for a password-protected PDF. */
const LOCKED_PDF = /password|encrypted/i;

/** The error core's on-device reader maps to ReadResult reason 'locked'. */
function lockedPdfError(): Error {
  return Object.assign(new Error('PDF is password protected'), { code: PDF_LOCKED_CODE });
}

let cached: Engines | null | undefined;

/** Loads both native modules once. null when either JS package or its native half is missing. */
function loadEngines(): Engines | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    // The JS wrappers load even when the native side is absent, so check the native registration too.
    if (!NativeModules.TextRecognition || !TurboModuleRegistry.get('PdfThumbnail')) return null;
    const mlMod = require('@react-native-ml-kit/text-recognition') as { default?: MlKit };
    const pdfMod = require('react-native-pdf-thumbnail') as { default?: PdfThumb };
    const ml = mlMod.default;
    const pdf = pdfMod.default;
    if (!ml || typeof ml.recognize !== 'function' || !pdf || typeof pdf.generate !== 'function') return null;
    cached = { ml, pdf };
  } catch {
    cached = null;
  }
  return cached;
}

/** True when this app build has the native text engine (false in Expo Go). */
export function ocrAvailable(): boolean {
  return loadEngines() !== null;
}

async function removeAll(uris: readonly string[]): Promise<void> {
  await Promise.all(uris.map((u) => deleteAsync(u, { idempotent: true }).catch(() => undefined)));
}

async function sizeOf(uri: string): Promise<{ width: number; height: number } | null> {
  try {
    const s = await Image.getSize(uri);
    return s.width > 0 && s.height > 0 ? s : null;
  } catch {
    return null;
  }
}

/**
 * TextExtractor for @wealthfire/core's on-device reader. One string per OCR pass:
 * normal read = the original image; strict (re-read) adds a 2x copy and 90/180/270 rotations.
 * Throws when the native engine is missing or the source image cannot be read at all.
 */
export const extractText: TextExtractor = async (doc: DocFile, opts: { strict: boolean }) => {
  const eng = loadEngines();
  if (!eng) throw new Error('Text recognition is not available in this app build');
  const temps: string[] = [];
  try {
    let src = doc.uri;
    let size: { width: number; height: number } | null = null;
    if (doc.mime === 'application/pdf') {
      let page: Awaited<ReturnType<PdfThumb['generate']>>;
      try {
        page = await eng.pdf.generate(doc.uri, 0, 90);
      } catch (e) {
        // Password-protected PDF: phones cannot take a password, so core reports reason 'locked'.
        if (LOCKED_PDF.test(e instanceof Error ? e.message : String(e))) throw lockedPdfError();
        throw e;
      }
      temps.push(page.uri);
      src = page.uri;
      size = { width: page.width, height: page.height };
    }
    const texts: string[] = [(await eng.ml.recognize(src)).text ?? ''];
    if (!opts.strict) return texts;

    size = size ?? (await sizeOf(src));
    const passes: Action[][] = ROTATIONS.map((rotate) => [{ rotate }]);
    if (size) {
      const scale = Math.min(2, MAX_SIDE / Math.max(size.width, size.height));
      if (scale > 1) passes.unshift([{ resize: { width: Math.round(size.width * scale) } }]);
    }
    for (const actions of passes) {
      try {
        const out = await manipulateAsync(src, actions, { compress: 0.95, format: SaveFormat.JPEG });
        temps.push(out.uri);
        texts.push((await eng.ml.recognize(out.uri)).text ?? '');
      } catch {
        // One extra pass failing is fine; the passes that did run still count.
      }
    }
    return texts;
  } finally {
    await removeAll(temps);
  }
};
