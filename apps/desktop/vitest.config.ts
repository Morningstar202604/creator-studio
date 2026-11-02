import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    globals: false,
    setupFiles: ['./test/setup.ts'],
    // Generous per-test ceiling so a loaded machine cannot turn a valid assertion
    // into a failure. Assertions themselves still settle as soon as they can.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
