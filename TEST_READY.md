# E2E Test Suite Ready (`TEST_READY.md`)

**Status:** READY FOR M6 EXECUTION  
**Owner:** `e2e_orch` (E2E Testing Track)  
**Total Tests:** **95** opaque-box Vitest E2E tests across 4 Tiers covering all **24 features** (`F1.1`–`F7.1`) in `PROJECT.md § Feature Inventory`.

## Suite Inventory

| File | Tier | Scope | Test Count |
|------|------|-------|------------|
| `tests/e2e/tier1_features.e2e.test.ts` | Tier 1 | Feature Coverage across all 7 areas (`F1.1`–`F7.1`, >= 5 per area) | 38 |
| `tests/e2e/tier2_boundaries.e2e.test.ts` | Tier 2 | Boundary & Corner Cases across all 7 areas (>= 5 per area) | 40 |
| `tests/e2e/tier3_combinations.e2e.test.ts` | Tier 3 | Pairwise Cross-Feature Combinations | 12 |
| `tests/e2e/tier4_scenarios.e2e.test.ts` | Tier 4 | Real-World End-to-End Scenarios (`ImageGrainsEngine` & `AnalysisSession`) | 5 |

## Infrastructure & Helpers
- `TEST_INFRA.md`: Full mock architecture, deterministic synthetic fixtures, and 24-feature test matrix.
- `tests/e2e/helpers/mocks.ts`: `MockIDBFactory`, `createMockFetch`, `createMockNavigator`, `createMockOnnxSession` (with `capturedInputs` & U-Net channel-1 zeroing validation), `MockWorker` (Transferable `ArrayBuffer` tracking), `PolyfillImageData`.
- `tests/e2e/helpers/syntheticData.ts`: Deterministic synthetic gravel/boulder/shadow images, analytical flow fields (isolated ellipses, touching dumbbells, border-touching clasts, `3ca10b7c` giant sand sheet both passing-QC and failing-QC pre-split), and independent `eval_core.py` (`1e-6`) & Folk & Ward (1957) reference oracles.

## Verification Status
- **TypeScript (`npx tsc --noEmit`):** 0 errors in `tests/e2e/helpers/*` and `tests/e2e/tier*.ts` (only the 4 expected `TS2307: Cannot find module '../../src/index.js'` errors until M5 lands `src/index.ts`).
- **Gate:** Reviewer 1 `APPROVE`, Reviewer 2 `APPROVE`, Challenger 1 `CONFIRM`, Challenger 2 `CONFIRM`, Forensic Auditor `CLEAN`.
- **Execution Command (for M6 once M1–M5 complete):**
  ```bash
  npx vitest run tests/e2e/
  ```
