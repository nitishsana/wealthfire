// Copies the self-hosted OCR assets for the web app into apps/web/public/ocr/ (git-ignored).
// Runs before `npm run dev` and `npm run build` in apps/web (predev / prebuild), so Tesseract
// never loads its worker, core or language data from a CDN (design Part C3).
//
//   ocr/worker.min.js                       tesseract.js web worker (its jsDelivr fallback disabled)
//   ocr/core/tesseract-core-*lstm.wasm.js   tesseract.js-core, LSTM-only builds (plain, SIMD, relaxed SIMD);
//                                           the worker picks one for the browser, each embeds its WASM
//   ocr/lang/eng.traineddata.gz             English LSTM model (@tesseract.js-data/eng 4.0.0_best_int,
//                                           tesseract.js's default for LSTM-only)
//   ocr/pdfjs/wasm/                         pdf.js image decoders (JPEG2000, JBIG2, colour profiles) for
//                                           scanned PDFs; passed to pdf.js as wasmUrl (QuickJS scripting skipped)
//   ocr/pdfjs/standard_fonts/               pdf.js standard fonts, passed as standardFontDataUrl
//   ocr/pdfjs/cmaps/                        pdf.js packed character maps (.bcmap), passed as cMapUrl
//
// Usage: node scripts/copy-ocr-assets.mjs
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps', 'web');
const outDir = join(webDir, 'public', 'ocr');

/** Finds an installed package folder, looking in apps/web first, then up to the repo root (npm hoisting). */
function pkgDir(name) {
  for (let dir = webDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) break;
  }
  throw new Error(`copy-ocr-assets: package "${name}" is not installed. Run npm install from the repo root.`);
}

const tesseract = pkgDir('tesseract.js');
const core = pkgDir('tesseract.js-core');
const eng = pkgDir('@tesseract.js-data/eng');
const pdfjs = pkgDir('pdfjs-dist');

/** Every file of `pkg/<sub>/` (no subfolders) except `skip`, as [from, ocr/pdfjs/<sub>/<file>] pairs. */
function pdfjsDir(sub, skip = () => false) {
  const dir = join(pdfjs, sub);
  if (!existsSync(dir)) throw new Error(`copy-ocr-assets: missing ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !skip(e.name))
    .map((e) => [join(dir, e.name), join('pdfjs', sub, e.name)]);
}

const files = [
  [join(tesseract, 'dist', 'worker.min.js'), 'worker.min.js'],
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map(
    (f) => [join(core, f), join('core', f)],
  ),
  [join(eng, '4.0.0_best_int', 'eng.traineddata.gz'), join('lang', 'eng.traineddata.gz')],
  // PDF scripting is never enabled, so the QuickJS engine is not needed.
  ...pdfjsDir('wasm', (name) => name.startsWith('quickjs')),
  ...pdfjsDir('standard_fonts'),
  // Packed character maps for PDFs whose (CJK / CID) fonts aren't embedded; passed as cMapUrl.
  ...pdfjsDir('cmaps'),
];

for (const [from] of files) {
  if (!existsSync(from)) throw new Error(`copy-ocr-assets: missing ${from}`);
}

rmSync(outDir, { recursive: true, force: true });
let total = 0;
for (const [from, to] of files) {
  const dest = join(outDir, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(from, dest);
  total += statSync(dest).size;
}

// The worker falls back to jsDelivr when corePath / langPath are missing. We always pass both, but
// disable the fallback too, so a wrong path fails the read instead of fetching from a CDN.
const workerFile = join(outDir, 'worker.min.js');
const CDN = 'https://cdn.jsdelivr.net/npm/';
const workerJs = readFileSync(workerFile, 'utf8');
if (!workerJs.includes(CDN)) throw new Error('copy-ocr-assets: worker CDN fallback not found; check the tesseract.js version');
writeFileSync(workerFile, workerJs.split(CDN).join('cdn-disabled:/'));
process.stdout.write(`copy-ocr-assets: ${files.length} files, ${(total / 1048576).toFixed(1)} MB -> apps/web/public/ocr/\n`);
