import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

// Dev proxies /api to the running Node server; production build emits into
// ../public so server.mjs serves the bundle directly (zero extra hosting).
export default defineConfig({
  root,
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:19321'
    }
  },
  build: {
    outDir: path.resolve(root, '..', 'public'),
    emptyOutDir: true
  }
});
