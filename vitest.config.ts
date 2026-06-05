import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const rendererSrc = fileURLToPath(new URL('./src/renderer/src', import.meta.url));
const sharedSrc = fileURLToPath(new URL('./src/shared', import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test/setup.ts'],
    globals: false
  },
  resolve: {
    alias: {
      '@': rendererSrc,
      '@shared': sharedSrc
    }
  }
});
