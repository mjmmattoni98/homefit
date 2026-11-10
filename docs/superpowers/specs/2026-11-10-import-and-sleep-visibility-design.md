# Google Health recovery and sleep visibility

The production metadata shows 37 completed metric backfills, one queued backfill and two retrying metrics. Metric HTTP 500 failures currently impose connection-wide backoff. Separately, the overview only charts Sleep Cycle and Hevy, while the source comparison incorrectly claims both sources have data whenever no nights match.

## Behavior

- Retry transient data failures per cursor and continue other claimable metrics. Retain shared backoff for token-refresh failures and HTTP 429 rate limits. Honor cursor retry times and preserve page tokens and reconciliation ownership. Resume legacy metric-wide connection delays without rewriting production data.
- Give recent incremental work priority over the historical backlog, so current data stays fresh during long imports. Show partial progress, affected metric names, safe error codes, retry timestamps and a manual retry action. A success on another metric must not hide pending retry issues. Manual retry preserves progress and resumes retrying cursors.
- Keep Sleep Cycle quality and Hevy training explicitly sourced. If the selected period has no data for those charts, render an explanatory empty state with All and Import actions instead of a tall empty chart and empty KPIs. Show available Google sleep measurements on the overview even without Sleep Cycle records for those dates. Never manufacture Sleep Cycle quality from Google data.
- Compare both sources within the selected dates. Distinguish absent Sleep Cycle, absent Google Health, no usable nights, and two present sources with no matching nights. Show per-source night counts and latest available dates. Keep the existing physical-overlap matching and minimum main-night duration; do not shift dates or combine nonoverlapping records to manufacture pairs.

## Verification and boundaries

Use synthetic records and PGlite for retry isolation, shared throttling, manual recovery, stale ownership, and source/window regression tests. Use existing browser component tests and the disposable Compose stack for desktop and narrow layouts. Run check, lint, unit tests with constrained concurrency, and Bun build. Do not read .env, inspect real health records, or mutate production data. The existing exception permits read-only production sync metadata only.
