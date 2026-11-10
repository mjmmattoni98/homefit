# Import recovery and sleep visibility implementation plan

**Goal:** Keep healthy Google Health imports progressing and make missing sleep data understandable.
**Architecture:** Cursor retry scheduling remains in the existing sync worker. Public connection status adds safe per-metric issues. The overview reuses the sleep source chart and keeps source-specific quality statistics separate.
**Spec:** `docs/superpowers/specs/2026-11-10-import-and-sleep-visibility-design.md`

## Tasks

- [x] Add regression coverage in `google-health/integration.spec.ts` for isolated metric errors, shared token/rate throttles, legacy delays, fair scheduling and manual retry without page loss. Extend the public status view using current-generation cursor metadata and latest run error codes.
- [x] Change `sync.ts` to scope backoff correctly, continue healthy work and prioritize incremental work. Update `connection.ts` to expose pending issues and resume delayed work manually. Preserve lifecycle and ownership checks.
- [x] Add a reusable import progress/details component, compose it into the import card and health banner, expose Sync now while delayed, and translate all copy in English and Spanish. Cover visible retry/error details and actions in browser tests.
- [x] Fix source availability/empty messages and add counts/latest dates in `sleep-sources.ts` and `SleepSourcesChart.svelte`. Cover selected-date and filtered-night cases with synthetic records.
- [x] Replace the overview's empty chart with an actionable state, include Google sleep when it is the only recent source, include Google history in All bounds and refresh dashboard data as imports progress. Add regression tests for Google-only and older Sleep Cycle periods.
- [x] Run the official Svelte autofixer, formatting, check, lint, unit tests with one worker, and Bun production build. Rebuild only `compose.test.yaml`; inspect synthetic data in the preview and verify narrow layouts.

## Validation

- PGlite regressions cover per-metric failures, shared token/rate throttling, incremental priority, legacy delays, authorization, and manual resume from the saved page.
- Browser component regressions cover retry details, access-renewal actions, absent sources, recent Google-only data, and restoring old Sleep Cycle history with All.
- The disposable app reproduces older Sleep Cycle/Hevy plus recent synthetic Google sleep. Desktop and 375 px layouts render the available Google data without horizontal overflow; All restores Sleep Cycle quality and the historical training volume.
- The disposable Docker image builds through `bun run build`. Production containers and health data were not changed.

Final checks: `bun run check` passed with zero errors and warnings; `bun run lint` passed; `bun run test:unit --run --maxWorkers 1 --no-file-parallelism` passed all 350 tests in 45 files. The Bun build and disposable app health check passed.
