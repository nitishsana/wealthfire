// Local mode guards (.kiro/specs/final-kyc-service/local-mode.md). Local-only behaviour (demo OTP
// code, demo reviewer token, local files, reset page) runs ONLY when STAGE is exactly 'local' AND
// the process is the local Node server, which binds 127.0.0.1 only. The Lambda handlers refuse
// STAGE=local (src/handlers/api.ts assertNotLocalStage).
import { LOCAL_STAGE } from '../router';

export { LOCAL_STAGE };

/** The one address the local server may bind. */
export const LOCAL_HOST = '127.0.0.1';

/** Throws unless `stage` is exactly 'local'. */
export function assertLocalStage(stage: string | undefined): void {
  if (stage !== LOCAL_STAGE) throw new Error(`The local server runs only with STAGE=${LOCAL_STAGE}`);
}

/** Throws unless `host` is exactly 127.0.0.1 (no 0.0.0.0, ::, localhost or a LAN address). */
export function assertLoopbackHost(host: string): void {
  if (host !== LOCAL_HOST) throw new Error(`The local server binds ${LOCAL_HOST} only`);
}
