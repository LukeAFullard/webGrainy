# Module refactor plan

Code organisation only: **no change in results or behaviour.** Each step is its own pull
request, guarded by the unit tests, the browser smoke test, and (where exports are touched) a
byte-for-byte comparison of every export against the previous build, as in PR #29.

Status key: ☐ to do · ◐ in progress · ☑ done (with PR link).

---

## Why

`src/ui/main.ts` has grown back to ~2,700 lines. It mixes four jobs: app actions (storage,
engine, state changes), rendering of each panel, event handling, and start-up. That makes the
app actions impossible to unit-test without a browser and the file hard to change safely.
`src/modules/siteAnalysis.ts` (~1,970 lines) similarly mixes pooling, uncertainty, adequacy and
CSV writing.

## Step 1 — App actions → `src/ui/workspaceActions.ts` ☑

Move the operations that change data, not the screen:

| Function now in `main.ts` | Moves to |
|---|---|
| `loadSiteData`, `createDefaultOrLoadSites` | `workspaceActions.ts` |
| `handleFilesAdded` | `workspaceActions.ts` |
| `runBatch`, `runAllSites`, `setFineGrainUpscale` | `workspaceActions.ts` |
| `persistActiveSession` | `workspaceActions.ts` |
| `applyCalibrationToActive`, `applyRectificationToActive` | `workspaceActions.ts` |
| `refreshComparison` (and its cache) | `workspaceActions.ts` |
| `recomputeReports`, `refreshCapabilities` | `workspaceActions.ts` |

They receive their dependencies (store, engine, storage functions, viewport callbacks)
through a small context object instead of module globals, so tests can pass fakes.

**Done when.** `main.ts` calls these functions only; new tests cover batch-run bookkeeping
(status maps, cancel stops all sites, fine-grain choice saved) with a fake engine and the
existing mock IndexedDB.

## Step 2 — Panel rendering → `src/ui/panels/` ☑

Pure "state → HTML string" functions, one file per panel:

- `panels/topbar.ts` — `renderTopbarHtml(state, engineInfo)`
- `panels/sidebar.ts` — guide, site, photo list, analysis settings
- `panels/toolbar.ts` — tool groups, Display menu, tool prompts
- `panels/dashboard.ts` — This photo / Whole site results, tabs, charts
- `panels/compare.ts` — Compare sites view

`main.ts` keeps only the DOM writes (`element.innerHTML = …`, focus and scroll restore). The
chart registry (`chartBox`) moves with the dashboard.

**Done when.** Each panel has snapshot-style tests for its key states (empty, analysing,
analysed, errors); the smoke test and screenshots are unchanged.

## Step 3 — Event handling split by area ☑

The ~600-line delegated click/change handler becomes a small router plus handlers per area:
`events/toolbar.ts`, `events/sidebar.ts`, `events/dashboard.ts`, `events/dialogs.ts`, each
calling the actions from Step 1.

**Done when.** Each handler module is tested with synthetic events; no handler exceeds
~150 lines.

## Step 4 — Split `siteAnalysis.ts` ☑

| New module | Contents |
|---|---|
| `siteCalibration.ts` | `validateSiteCalibration`, `withExclusionTolerance` |
| `sitePooling.ts` | pooled arrays per pooling mode, Wentworth and fabric pooling |
| `siteUncertainty.ts` | bootstrap (cluster / two-stage), binomial CIs, jackknife, convergence |
| `siteAdequacy.ts` | sample adequacy rating, largest clast, outlier photos |
| `exports.ts` (existing) | site summary CSV/JSON and pooled grains CSV writers |
| `siteAnalysis.ts` | `analyzeSite` orchestration and the report type; re-exports for compatibility |

**Done when.** All site tests pass unchanged; site exports are byte-identical to the previous
build on the comparison fixture.

## Step 5 — Housekeeping ☐

- Remove the now-unused legacy chart helpers and dead code found during the moves.
- Update the README module map.

---

## Order and safety

Steps 1 → 2 → 3 depend on each other (actions first, then rendering, then events). Step 4 is
independent and can be done at any point. After each step: type check, full test suite,
browser smoke test, a real analysis run in Chromium, and the export comparison where relevant.
