/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OTP provider id: unset or 'demo' in v1. 'digilocker' / 'digio' need a backend (not built yet). */
  readonly VITE_OTP_PROVIDER?: string;
  /** Backend base URL for a real OTP provider. Unused by the demo provider. */
  readonly VITE_OTP_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
