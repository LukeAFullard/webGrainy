import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['validation/interval_coverage/*.audit.ts'],
    testTimeout: 3_600_000,
  },
});
