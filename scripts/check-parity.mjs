// Fails if web, Android or iOS is missing a feature listed in packages/core/src/features.ts,
// or if the mobile and web color themes drift apart. Run: npm run parity
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const walk = (dir) => readdirSync(join(root, dir)).flatMap((f) => {
  const rel = join(dir, f);
  return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.(tsx?|jsx?)$/.test(f) ? [rel] : [];
});
const allText = (dir) => walk(dir).map(read).join('\n');

const features = [...read('packages/core/src/features.ts').matchAll(/id:\s*'([\w-]+)'/g)].map((m) => m[1]);
const web = allText('apps/web/src');
const mobile = allText('packages/mobile-ui/src');
const errors = [];

for (const id of features) {
  if (!web.includes(`feature="${id}"`)) errors.push(`web is missing feature "${id}"`);
  if (!mobile.includes(`feature="${id}"`)) errors.push(`mobile (Android + iOS) is missing feature "${id}"`);
}
for (const app of ['android', 'ios']) {
  const src = read(`apps/${app}/App.tsx`);
  if (!src.includes('WealthfireApp') || !src.includes(`platform="${app}"`)) errors.push(`apps/${app}/App.tsx does not render WealthfireApp for ${app}`);
}

// Theme colors must match between web CSS and mobile theme.
const css = read('apps/web/src/styles.css');
const theme = read('packages/mobile-ui/src/theme.ts');
const pairs = { bg: 'bg', panel: 'panel', 'panel-2': 'panel2', line: 'line', text: 'text', muted: 'muted', accent: 'accent', good: 'good', warn: 'warn', bad: 'bad' };
for (const [cssVar, key] of Object.entries(pairs)) {
  const c = css.match(new RegExp(`--${cssVar}:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]?.toLowerCase();
  const t = theme.match(new RegExp(`\\b${key}:\\s*'(#[0-9a-fA-F]{3,8})'`))?.[1]?.toLowerCase();
  if (c !== t) errors.push(`color "${cssVar}" differs: web ${c} vs mobile ${t}`);
}

if (errors.length) {
  console.error('Parity check FAILED:\n - ' + errors.join('\n - '));
  process.exit(1);
}
console.log(`Parity OK: ${features.length} features on web, Android and iOS; themes match.`);
