import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['validation/comparison/false_positive_rate.audit.ts'],
    testTimeout: 900_000,
  },
});
