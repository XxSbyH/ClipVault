import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test/setup.ts'],
    globals: false
  },
  resolve: {
    alias: {
      '@': '/src/renderer/src',
      '@shared': '/src/shared'
    }
  }
});
