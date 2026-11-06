// Bundles each Lambda handler in src/handlers/*.ts into dist/<name>/index.mjs for CDK to deploy.
import { build } from 'esbuild';
import { readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'src', 'handlers');
const entries = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.ts')) : [];

for (const f of entries) {
  const name = basename(f, '.ts');
  await build({
    entryPoints: [join(dir, f)],
    outfile: join(root, 'dist', name, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    // AWS SDK v3 is provided by the Lambda Node.js 22 runtime.
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });
}
console.log(`bundled ${entries.length} handler(s)`);
