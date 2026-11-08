# Daily Home Goals Design

**Date:** 2026-11-08

**Status:** Approved for implementation planning

## Summary

HomeFit will let a user set daily goals for training at home during the workday: walking-pad minutes plus bodyweight strength counted in reps or held seconds. Each goal has a daily target. The user fills it with quick-add taps throughout the day, and a day is done when every goal is met. Done days on the user's chosen weekdays build a streak.

Home goals are a separate model. They do not write to the Hevy `workout` / `workout_set` tables and do not feed the existing training analytics.

## Goals

- Define any number of goals, each with a name, a unit (`minutes`, `reps` or `seconds`) and a positive integer daily target.
- Log progress in two taps from a phone or laptop: preset amounts per unit, a custom amount, and undo.
- Log for today or any past day, never a future day.
- Choose the weekdays on which goals apply. Other days are rest days.
- Show today's progress, the current streak, the best streak and the last 12 weeks of day statuses.
- Keep history accurate when targets, the schedule or the goal list change later.

## Non-goals

- Feeding home entries into the Hevy volume, readiness or sleep/training charts.
- Recording weight, sets, RPE or distance for home entries.
- A walking-pad timer, reminders or notifications.
- Per-goal preset amounts or per-goal schedules.
- Points, scores or goals spanning a week.

## Data Model

Four new tables in `src/lib/server/db/schema.ts`, delivered in one migration generated with `bun run db:generate`. Every table cascades on user deletion.

### `daily_goal`

| Column        | Type        | Notes                                        |
| ------------- | ----------- | -------------------------------------------- |
| `id`          | uuid PK     |                                              |
| `user_id`     | text FK     | `ownerId()`                                  |
| `name`        | text        | 1–100 characters, trimmed                    |
| `unit`        | text        | `'minutes' \| 'reps' \| 'seconds'`, fixed at creation |
| `sort_order`  | integer     | display order                                |
| `archived_on` | date, null  | the goal does not count from this day onward |
| `created_at`  | timestamptz |                                              |

Index on `(user_id, sort_order)`.

### `daily_goal_target`

| Column           | Type    | Notes                          |
| ---------------- | ------- | ------------------------------ |
| `goal_id`        | uuid FK | cascades on goal deletion      |
| `effective_from` | date    | first day this target applies  |
| `target`         | integer | 1–10,000                       |

Primary key `(goal_id, effective_from)`. Creating a goal writes its first target with `effective_from` set to the user's local today. Changing a target upserts a row for today, so several changes on the same day leave one row.

### `daily_goal_schedule`

| Column           | Type        | Notes                                    |
| ---------------- | ----------- | ---------------------------------------- |
| `user_id`        | text FK     |                                          |
| `effective_from` | date        |                                          |
| `weekdays`       | smallint    | 7-bit mask, bit 0 = Monday … bit 6 = Sunday; must be non-zero |

Primary key `(user_id, effective_from)`, upserted the same way as targets. A user without any schedule row has no scheduled days, which is the default until they set a schedule during goal setup.

### `daily_goal_entry`

| Column       | Type        | Notes                                  |
| ------------ | ----------- | -------------------------------------- |
| `id`         | uuid PK     |                                        |
| `goal_id`    | uuid FK     | cascades on goal deletion              |
| `user_id`    | text FK     | denormalized for ownership checks      |
| `day`        | date        | the user's local date the entry counts for |
| `amount`     | integer     | 1–10,000, in the goal's unit           |
| `created_at` | timestamptz | orders entries for undo                |

Index on `(user_id, day)` and `(goal_id, day, created_at)`.

## Rules

These rules live in a pure module, `src/lib/daily-goals.ts`, with no database access. Dates are `YYYY-MM-DD` strings handled by `src/lib/days.ts`.

- **Target in effect** for a goal on day `D`: the target row with the latest `effective_from` that is on or before `D`.
- **Active goal** on day `D`: it has a target in effect on `D`, and `archived_on` is null or after `D`. Inactive goals are hidden for that day, along with any entries logged against them.
- **Scheduled day:** the schedule row with the latest `effective_from` on or before `D` has `D`'s weekday bit set.
- **Goal met:** the sum of its entries on `D` is at least the target in effect on `D`.
- **Day status**, given today `T`:
  - `done`: `D` is scheduled, has at least one active goal, and every active goal is met.
  - `in-progress`: `D = T`, `D` is scheduled, and the day is not done.
  - `missed`: `D < T`, `D` is scheduled, and the day is not done. This includes a scheduled day with no active goals.
  - `rest`: `D` is not scheduled, including when `D = T`. Entries logged on rest days are still shown. A rest day that meets every goal is shown as rest with a met marker and does not change the streak.
- **Current streak:** walk back from `T`. Skip `T` if it is `in-progress`, and skip rest days. Count consecutive `done` days until the first `missed` day or the first day before the user's earliest goal target.
- **Best streak:** the longest run of `done` days separated only by rest days, from the earliest goal target up to `T`, computed on read. No streak value is stored.

## Server

`src/lib/server/daily-goals.ts`, where every function takes `db: Database` and `userId`. Writes that touch goals check that the goal belongs to `userId` and throw a not-found error otherwise.

- `loadGoalDay(db, userId, day, today)`: the active goals for `day` in `sort_order`, each with its unit, the target in effect, the total and that day's entries, plus whether the day is scheduled and its status.
- `loadGoalHistory(db, userId, today, days)`: the status of each day for the last `days` days ending at `today`, plus the current and best streak.
- `listGoals(db, userId, today)`: the non-archived goals with their current targets, and the current weekday mask, for the settings sheet.
- `createGoal(db, userId, today, { name, unit, target })`: appends the goal at the end of the sort order.
- `updateGoal(db, userId, today, goalId, { name?, target? })`
- `reorderGoals(db, userId, goalIds)`: the list must contain exactly the user's non-archived goals.
- `archiveGoal(db, userId, today, goalId)`: sets `archived_on = today`.
- `setSchedule(db, userId, today, weekdays)`
- `addEntry(db, userId, today, { goalId, day, amount })`: rejects `day > today` and goals that are not active on `day`.
- `undoLastEntry(db, userId, { goalId, day })`: deletes the newest entry for that goal and day. It does nothing if there are none.

## Remote Functions

`src/lib/remote/goals.remote.ts`. `today` is always computed on the server from the time-zone cookie through `resolveTimeZone`, matching `imports.remote.ts`. Inputs are validated with valibot: dates match `YYYY-MM-DD` and are real calendar dates, amounts and targets are integers from 1 to 10,000, names are 1–100 characters after trimming, the weekday mask is from 1 to 127, and history windows are from 1 to 366 days.

- Queries: `getGoalDay(day)`, `getGoalHistory(days)`, `getGoals()`.
- Commands: `createGoal`, `updateGoal`, `reorderGoals`, `archiveGoal`, `setSchedule`, `addEntry`, `undoLastEntry`. Each command refreshes the queries it affects on the client after it succeeds.

## User Interface

### Today page: `/dashboard/today`

- Listed in the dashboard nav right after Overview, with a command-palette entry, using the Lucide `target` icon.
- **Header:** the formatted date, ‹ › buttons to move between days (› is disabled on today, and the day is kept in a `?day=` search parameter), a day-status badge, and the current streak.
- **Goal cards**, one per active goal: the name, a progress bar with "24 / 60 min", a check mark when met, preset buttons, a numeric custom-amount input with an add button, and an undo button that is disabled when the goal has no entries that day. Presets:
  - minutes: +5, +10, +15
  - reps: +5, +10, +20
  - seconds: +15, +30, +60
- **History strip:** the last 12 weeks as a grid of day cells (done, missed, rest, today, and rest with a met marker), with the best streak. Clicking a cell opens that day.
- **Rest-day notice:** on an unscheduled day, a small note says it is a rest day and logging is optional.
- **Empty state:** with no goals, a short explanation and a "Set up your daily goals" button that opens the settings sheet pre-filled with suggestions (Walking pad 60 minutes, Push-ups 100 reps, Plank 120 seconds) and Monday to Friday selected, all editable before saving.

### Manage goals sheet

Opened from a "Manage goals" button on the Today page. It lists the goals with editable name and target fields, up/down buttons for ordering, and an archive button that asks for confirmation through `alert-dialog`. It also has an "Add goal" row (name, unit, target) and weekday chips through `toggle-group`, of which at least one must be selected.

### Overview card

The `/dashboard` overview gets a compact "Today's goals" card showing "2 / 3 done", the current streak and a link to the Today page. When no goals exist, it shows a link to set them up.

### Conventions

The UI uses shadcn-svelte components from `src/lib/components/ui` (card, progress, button, input, sheet, toggle-group, alert-dialog), the existing design tokens, and Paraglide messages added to both `en` and `es`. Svelte code is checked with the Svelte MCP autofixer.

## Error Handling

- Writes are not optimistic. The UI updates after the command succeeds and its queries refresh. A failure shows a Sonner toast and leaves the displayed values unchanged.
- Preset and add buttons are disabled while their command is pending, so a double tap cannot submit twice.
- Validation failures and not-found errors from remote functions come back as errors and are shown as toasts.
- Undo with no entries does nothing and returns nothing.

## Testing

- **Rules unit tests** (`src/lib/daily-goals.spec.ts`): the target in effect across versions, archiving, schedule versions, every day status, a streak across rest days, an in-progress today that does not break the streak, a missed scheduled day with no goals, a met rest day that does not count toward the streak, and the best streak.
- **Server tests against PGlite** (`src/lib/server/daily-goals.spec.ts`): create, update and archive goals; same-day target upserts; adding and undoing entries; rejecting future days and inactive goals; reorder validation; and isolation between users.
- **Component test** for the goal card: the progress text, the met state, the presets per unit, and undo being disabled without entries.
- Run `bun run check`, `bun run lint` and `bun run test:unit --run`, then check the feature by hand on the disposable `compose.test.yaml` stack with a fresh test account.
