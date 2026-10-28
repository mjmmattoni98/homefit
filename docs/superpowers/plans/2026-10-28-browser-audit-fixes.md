# Browser audit fixes

Scope: repair the four defects reproduced on 2026-10-28. Product improvements remain separate.

## Implementation

- [x] Gate account deletion on explicit confirmation for both mouse and keyboard input. Add a browser regression for Enter and Cancel, and verify only the dialog confirmation submits the action.
- [x] Share a sleep record schema between CSV parsing and the remote command. Reject out-of-range percentages, negative durations and reversed timestamps; reject impossible calendar dates while parsing. Preserve valid exports, duplicate handling and optional columns. Add parser and boundary-schema regressions.
- [x] Reserve enough horizontal space for health-chart tick labels. Verify rendered labels remain inside the chart at desktop and mobile widths, including longer units.
- [x] Adapt the public header at narrow widths using the existing compact language menu, with wrapping if necessary. Verify Spanish auth links fit at 320px and 375px.
- [x] Run focused regressions, Svelte autofixer, `bun run check`, `bun run lint`, `bun run test:unit --run`, `bun run build` and `git diff --check`.

## Constraints

Keep changes scoped and preserve the existing interaction semantics after confirmation. No database migration, dependency changes, commits, or deployment changes are needed. Use browser component tests for UI interactions and layout; do not connect a real Google account or modify existing user records.

## Verification

All 233 tests pass across 32 files. Type checking reports no errors or warnings; lint and production build pass. Svelte autofixer reports no issues for the four edited components. Against the original source, the regression suite fails 19 cases across all four defect areas. A live HTTP check verifies rejection of unconfirmed deletion, continued account access afterward, and successful confirmed deletion; its disposable account was removed.
