// Local KYC server: `npm run local -w @wealthfire/kyc-service` (tsx). No AWS is called.
//   API             http://127.0.0.1:5181   (real router + KYC service, local adapters)
//   Review console  http://127.0.0.1:5182   (review-console/dist + a local /config.json)
//   Reset page      http://127.0.0.1:5181/local/reset
// STAGE defaults to 'local'; any other STAGE, or KYC_LOCAL_HOST other than 127.0.0.1, is refused.
// Test data is kept in services/kyc/.local-data/ (gitignored) between runs.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_API_PORT, DEFAULT_APP_ORIGIN, DEFAULT_CONSOLE_PORT, hasLocalConsoleBuild, startLocalServer,
} from '../src/local/app';
import { LOCAL_HOST, LOCAL_STAGE } from '../src/local/guard';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function port(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) throw new Error(`${name} must be a port number`);
  return Number(v);
}

/** Builds the console in local mode (`build.mjs --local`) unless dist already is a local build. */
function ensureLocalConsole(dist: string): void {
  if (hasLocalConsoleBuild(dist)) return;
  console.log('Building the review console for local mode (build.mjs --local)...');
  const r = spawnSync(process.execPath, [join(serviceDir, 'review-console', 'build.mjs'), '--local'], { cwd: serviceDir, stdio: 'inherit' });
  if (r.status !== 0 || !hasLocalConsoleBuild(dist)) {
    console.error('The review console could not be built for local mode; the console page will show how to build it.');
  }
}

async function main(): Promise<void> {
  const stage = process.env.STAGE ?? LOCAL_STAGE;
  const consoleDist = join(serviceDir, 'review-console', 'dist');
  if (stage === LOCAL_STAGE) ensureLocalConsole(consoleDist);
  const server = await startLocalServer({
    stage,
    host: process.env.KYC_LOCAL_HOST ?? LOCAL_HOST,
    apiPort: port('KYC_LOCAL_API_PORT', DEFAULT_API_PORT),
    consolePort: port('KYC_LOCAL_CONSOLE_PORT', DEFAULT_CONSOLE_PORT),
    dataDir: join(serviceDir, '.local-data'),
    consoleDist,
    appOrigin: process.env.KYC_LOCAL_APP_ORIGIN ?? DEFAULT_APP_ORIGIN,
  });
  console.log(`Local test home: ${server.homeUrl}`);
  console.log('Wealthfire local KYC server (this computer only, no AWS)');
  console.log(`  API:            ${server.apiUrl}`);
  console.log(`  Review console: ${server.consoleUrl}`);
  console.log(`  Reset data:     ${server.resetUrl}`);
  console.log('OTP codes show here as "DEMO code for ...". Press Ctrl+C to stop.');
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e: unknown) => {
  const err = e as { code?: string; message?: string };
  if (err.code === 'EADDRINUSE') {
    console.error('Local KYC server: port 5181 or 5182 is already in use (is the preview already running?).');
  } else {
    console.error(`Local KYC server did not start: ${err.message ?? 'unknown error'}`);
  }
  process.exit(1);
});
