import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['validation/comparison/power.audit.ts'],
    testTimeout: 7_200_000,
  },
});
