import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'web',
  base: '/silent-speech/',
  build: { outDir: '../dist', emptyOutDir: true,
    rollupOptions: { input: { main: fileURLToPath(new URL('./web/index.html', import.meta.url)),
      study: fileURLToPath(new URL('./web/study.html', import.meta.url)) } } },
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] } },
  preview: { port: 4173 },
});
