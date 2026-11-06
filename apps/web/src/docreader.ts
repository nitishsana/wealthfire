// One document reader for the page's life (design Part C2/C3).
// Default: the on-device reader. The card is read in this browser (Tesseract + pdf.js, ./ocr.ts)
// and only the parsed number is used; files and text never leave the device.
// A partner reader (Digio / HyperVerge) needs a backend; set VITE_DOC_READER + VITE_DOC_READER_URL then.
import { createDocumentReader, DemoDocumentReader, type DemoReadMode, type DocumentReader } from '@wealthfire/core';
import { extractText, onOcrProgress, terminateOcr } from './ocr';

/** Reading progress 0..1 of the document being read now (on-device reader only); returns unsubscribe. */
export const onProgress = onOcrProgress;
/** Frees the OCR engine; call when onboarding completes. */
export { terminateOcr };

const MODES: readonly DemoReadMode[] = ['match', 'misread', 'different', 'unreadable'];

/**
 * Developer switch for the scenario launchers in "CMD files/", never shown in the UI (design C5).
 * Only in the Vite dev server (`import.meta.env.DEV`; this branch is removed from `npm run build`
 * output): `?reader=demo` uses the demo reader, which reads nothing, and `&mode=match|misread|
 * different|unreadable` picks its result (default 'match'; any other value is ignored).
 */
function devDemoReader(): DocumentReader | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('reader') !== 'demo') return null;
  const m = params.get('mode');
  return new DemoDocumentReader(m && (MODES as readonly string[]).includes(m) ? (m as DemoReadMode) : 'match');
}

/** VITE_DOC_READER, except that a production build never runs the demo reader: 'demo' falls back to on-device. */
function configuredReader(): string | undefined {
  const id = import.meta.env.VITE_DOC_READER;
  return !import.meta.env.DEV && id === 'demo' ? 'ondevice' : id;
}

export const documentReader: DocumentReader =
  devDemoReader() ??
  createDocumentReader({
    reader: configuredReader(),
    apiUrl: import.meta.env.VITE_DOC_READER_URL,
    extract: extractText,
  });
