import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['validation/comparison/*.audit.ts'],
    testTimeout: 900_000,
  },
});
