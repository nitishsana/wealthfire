import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const CDN = 'https://cdn.jsdelivr.net/npm/';

/**
 * tesseract.js keeps a jsDelivr default for its worker path. We always pass a self-hosted workerPath
 * (src/ocr.ts), so the default is dead code; this swaps it for a non-working prefix so the build holds
 * no CDN URL and a wrong path fails instead of fetching from a CDN (design Part C3). Build only.
 * The build fails if any CDN URL is still left in the output JS.
 */
function noOcrCdn(): Plugin {
  return {
    name: 'wealthfire-no-ocr-cdn',
    apply: 'build',
    transform(code, id) {
      if (!/[\\/]node_modules[\\/]tesseract\.js[\\/]/.test(id) || !code.includes(CDN)) return null;
      return { code: code.split(CDN).join('cdn-disabled:/'), map: null };
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.code.includes('cdn.jsdelivr')) this.error(`CDN URL left in ${file.fileName}`);
      }
    },
  };
}

// GitHub Pages serves the site from /wealthfire/. Locally it's /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/wealthfire/' : '/',
  plugins: [react(), noOcrCdn()],
}));
