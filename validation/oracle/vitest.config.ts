import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['validation/oracle/*.audit.ts'], testTimeout: 120000 } });
