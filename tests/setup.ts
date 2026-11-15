// Global test setup: unit tests feed synthetic (non-genuine) model payloads, so the
// production SHA-256/size verification is disabled here. Tests that exercise
// integrity enforcement re-enable it explicitly via setModelIntegrityEnforcement(true).
import { beforeEach } from 'vitest';
import { setModelIntegrityEnforcement } from '../src/modules/modelCache.js';

beforeEach(() => {
  setModelIntegrityEnforcement(false);
});
