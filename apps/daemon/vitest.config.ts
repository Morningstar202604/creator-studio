import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Several suites boot a real Fastify daemon and a SQLite file; under the full
    // parallel run a 5s default timeout was flaky (passing alone, timing out in the
    // gate). The work itself is bounded, so the budget is the thing to raise.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
