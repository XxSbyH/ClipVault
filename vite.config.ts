import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const rendererRoot = resolve(projectRoot, 'src/renderer');

export default defineConfig({
  root: rendererRoot,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  },
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src/renderer/src'),
      '@shared': resolve(projectRoot, 'src/shared')
    }
  },
  build: {
    outDir: resolve(projectRoot, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(rendererRoot, 'index.html'),
        hud: resolve(rendererRoot, 'hud.html')
      }
    }
  }
});
