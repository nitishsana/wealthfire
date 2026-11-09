// Builds the review console into review-console/dist/: type-checks src/ (DOM lib), bundles
// src/main.ts with esbuild, bakes in config (review-console/config.json, else the placeholder
// config.example.json) and writes a strict CSP whose connect-src lists only the API and Cognito.
//   node services/kyc/review-console/build.mjs [--config path/to/config.json]
import { build } from 'esbuild';
import ts from 'typescript';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');

// ---------- config ----------
const argIdx = process.argv.indexOf('--config');
const configPath = argIdx > 0 && process.argv[argIdx + 1]
  ? resolve(process.argv[argIdx + 1])
  : existsSync(join(here, 'config.json')) ? join(here, 'config.json') : join(here, 'config.example.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const FIELDS = ['apiUrl', 'cognitoDomain', 'clientId', 'redirectUri', 'logoutUri'];
for (const k of FIELDS) {
  if (typeof config[k] !== 'string' || config[k] === '') throw new Error(`config.${k} is missing`);
}
for (const k of Object.keys(config)) {
  if (!FIELDS.includes(k)) throw new Error(`config.${k} is not a known field (no secrets belong in this file)`);
}
const isLocal = (u) => u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
const origins = {};
for (const k of ['apiUrl', 'cognitoDomain', 'redirectUri', 'logoutUri']) {
  const u = new URL(config[k]);
  if (u.protocol !== 'https:' && !(k.endsWith('Uri') && isLocal(u))) throw new Error(`config.${k} must be https`);
  origins[k] = u.origin;
}
if (configPath.endsWith('config.example.json')) {
  console.warn('review-console: using config.example.json placeholders; copy it to config.json with real values');
}

// ---------- type-check ----------
const tsconfigPath = join(here, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diags = ts.getPreEmitDiagnostics(program);
if (diags.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diags, {
    getCanonicalFileName: (f) => f, getCurrentDirectory: () => here, getNewLine: () => '\n',
  }));
  process.exit(1);
}

// ---------- bundle ----------
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: { __CONFIG__: JSON.stringify(config) },
});

// ---------- html + CSP ----------
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  `connect-src ${origins.apiUrl} ${origins.cognitoDomain}`,
  "base-uri 'none'",
  "form-action 'none'",
  // a local http preview would break if its own requests were upgraded
  ...(origins.redirectUri.startsWith('https:') ? ['upgrade-insecure-requests'] : []),
].join('; ');
const html = readFileSync(join(here, 'index.html'), 'utf8').replace('%CSP%', csp);
if (html.includes('%CSP%')) throw new Error('CSP placeholder left in index.html');
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(here, 'styles.css'), join(out, 'styles.css'));
console.log(`review-console built to ${out}`);
