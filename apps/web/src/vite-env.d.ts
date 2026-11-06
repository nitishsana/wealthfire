/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OTP provider id: unset or 'demo' in v1. 'digilocker' / 'digio' need a backend (not built yet). */
  readonly VITE_OTP_PROVIDER?: string;
  /** Backend base URL for a real OTP provider. Unused by the demo provider. */
  readonly VITE_OTP_API_URL?: string;
  /**
   * Document reader id: unset or 'ondevice' (default) reads the card in the browser (./ocr.ts).
   * 'demo' reads nothing (local testing only). 'digio' / 'hyperverge' need a backend (not built yet).
   */
  readonly VITE_DOC_READER?: string;
  /** Backend base URL for a partner document reader. Unused by the on-device and demo readers. */
  readonly VITE_DOC_READER_URL?: string;
  /** Public Google OAuth web client id (repo variable GOOGLE_WEB_CLIENT_ID). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Google API key for the Drive Picker, restricted to the site origins (repo variable GOOGLE_API_KEY). */
  readonly VITE_GOOGLE_API_KEY?: string;
  /** Google Cloud project number for the Drive Picker (repo variable GOOGLE_APP_ID). */
  readonly VITE_GOOGLE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
