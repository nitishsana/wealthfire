import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the site from /wealthfire/. Locally it's /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/wealthfire/' : '/',
  plugins: [react()],
}));
