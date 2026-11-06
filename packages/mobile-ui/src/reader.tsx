// One document reader for the app's life, shared with the onboarding screens (design B3, C2, C4).
// Default: the on-device reader (ML Kit through ./ocr). Files never leave the phone.
// If the native text engine is missing (e.g. Expo Go), core's reader fails every read with
// DOC_MESSAGES.readerUnavailable; it never falls back to a fake match.
// The demo reader is used ONLY in a dev build (__DEV__) whose app.json extra sets docReader 'demo';
// its mode comes from extra.demoReaderMode and is never shown in the UI.
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createDocumentReader, DemoDocumentReader, type DemoReadMode, type DocumentReader } from '@wealthfire/core';
import { extractText, ocrAvailable } from './ocr';

export interface DocReaderConfig {
  reader?: string;
  apiUrl?: string;
  /** Dev builds only. Ignored unless it is one of the four demo modes. */
  demoMode?: string;
}

const DEMO_MODES: readonly DemoReadMode[] = ['match', 'misread', 'different', 'unreadable'];
const isDemoMode = (v: unknown): v is DemoReadMode => typeof v === 'string' && (DEMO_MODES as readonly string[]).includes(v);

const ReaderCtx = createContext<DocumentReader | null>(null);

function makeReader(config: DocReaderConfig): DocumentReader {
  // A release build ignores 'demo' and reads documents for real.
  const reader = config.reader === 'demo' && !__DEV__ ? undefined : config.reader;
  const extract = ocrAvailable() ? extractText : undefined;
  // The on-device reader (or, without the native engine, the one that fails with readerUnavailable).
  const onDevice = () => createDocumentReader({ reader: undefined, extract });
  let r: DocumentReader;
  try {
    r = createDocumentReader({ reader, apiUrl: config.apiUrl, extract });
  } catch {
    // Bug 11: an unknown docReader id in app.json must not crash the app at launch.
    r = onDevice();
  }
  // Never the demo reader outside a dev build, whatever the config says.
  if (r.isDemo && !__DEV__) r = onDevice();
  if (r instanceof DemoDocumentReader) r.mode = isDemoMode(config.demoMode) ? config.demoMode : 'match';
  return r;
}

export function DocReaderScope({ config, children }: { config: DocReaderConfig; children: ReactNode }) {
  // Created once; a config change needs an app restart (same as the OTP provider).
  const [reader] = useState<DocumentReader>(() => makeReader(config));
  return <ReaderCtx.Provider value={reader}>{children}</ReaderCtx.Provider>;
}

export function useDocReader(): DocumentReader {
  const r = useContext(ReaderCtx);
  if (!r) throw new Error('useDocReader outside DocReaderScope');
  return r;
}
