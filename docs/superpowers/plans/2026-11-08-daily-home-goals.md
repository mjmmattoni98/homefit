# Daily Home Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a HomeFit user set daily home-training goals (walking-pad minutes, reps, held seconds), log progress with quick-add taps, and track done days and streaks on chosen weekdays.

**Architecture:** A pure rules module (`src/lib/daily-goals.ts`) decides targets, day status and streaks from plain data. A server module (`src/lib/server/daily-goals.ts`) stores goals, versioned targets, a versioned weekday schedule and entries in four new Drizzle tables, and feeds those rows to the rules. Remote functions (`src/lib/remote/goals.remote.ts`) expose it to a new Today page, a goal-settings sheet and a compact Overview card. Commands use single-flight refreshes, so each write comes back with fresh data.

**Tech Stack:** SvelteKit 3 (remote functions, Svelte 5 runes, experimental async), Drizzle ORM on PostgreSQL (PGlite in tests), valibot, Paraglide (en, es), shadcn-svelte, Tailwind 4, Vitest (node and browser projects), Bun.

**Spec:** `docs/superpowers/specs/2026-11-08-daily-home-goals-design.md`

## Global Constraints

- Units are exactly `minutes`, `reps`, `seconds`; a goal's unit is fixed at creation.
- Targets and entry amounts are integers from 1 to 10,000 (`MAX_AMOUNT`). Goal names are 1–100 characters after trimming. Weekday masks run from 1 to 127, with bit 0 = Monday … bit 6 = Sunday.
- Quick-add presets: minutes +5/+10/+15, reps +5/+10/+20, seconds +15/+30/+60.
- The history window is the last 84 days (12 weeks) ending today (`HISTORY_DAYS`).
- "Today" is always computed on the server from the `tz` cookie with `resolveTimeZone` and `localDate` from `src/lib/server/dashboard.ts`. Logging is allowed for today or earlier, never a future day.
- Home goals never write to `workout` or `workout_set`.
- Server functions take `db: Database` (or a transaction) and `userId` first, so they run against PGlite in tests.
- All UI copy goes through Paraglide with both `messages/en.json` and `messages/es.json`. Run all Svelte code through the Svelte MCP `svelte-autofixer` until it reports no issues.
- Before finishing: `bun run check`, `bun run lint`, `bun run test:unit --run`.
- Never touch the real Compose project `homefit`, `.env`, `compose.dev.yaml` or `bun run db:start`. Manual testing uses only `compose.test.yaml`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Refinements to the spec

These came out of reading the code while planning. They are already reflected in the spec.

- The day is a path segment, `/dashboard/today/2026-11-07` (route `src/routes/dashboard/today/[[day]]`), instead of `?day=`. The repo's ESLint rule `svelte/no-navigation-without-resolve` rejects hand-built query strings, while `resolve('/dashboard/today/[[day]]', { day })` passes.
- `getGoalDay(day: string | null)`: `null` means the server's today. `getGoalHistory()` takes no argument and always covers `HISTORY_DAYS`.
- The weekday and unit pickers are plain `aria-pressed` buttons, not `toggle-group`, so they stay fully controlled. Otherwise the last selected day could be deselected.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/daily-goals.ts` (create) | Pure rules: units, presets, limits, target/schedule versions, day status, history and streaks |
| `src/lib/daily-goals.spec.ts` (create) | Unit tests for the rules |
| `src/lib/server/db/schema.ts` (modify) | Four new tables |
| `drizzle/0003_daily_goals.sql` + `drizzle/meta/*` (generated) | Migration |
| `src/lib/server/daily-goals.ts` (create) | Persistence: goal settings, entries, day and history loaders |
| `src/lib/server/daily-goals.spec.ts` (create) | PGlite tests |
| `src/lib/remote/goals.remote.ts` (create) | Validated queries and commands |
| `messages/en.json`, `messages/es.json` (modify) | Copy |
| `src/lib/components/goals/labels.ts` (create) | Unit and status labels |
| `src/lib/components/goals/GoalCard.svelte` (+ `.svelte.spec.ts`) (create) | One goal's progress and quick-add |
| `src/lib/components/goals/GoalHistoryStrip.svelte` (create) | 12-week grid of day statuses |
| `src/lib/components/goals/WeekdayPicker.svelte` (create) | Weekday mask control |
| `src/lib/components/goals/GoalSettingsRow.svelte` (create) | Edit, reorder and archive one goal |
| `src/lib/components/goals/AddGoalForm.svelte` (create) | Add one goal |
| `src/lib/components/goals/GoalSetupForm.svelte` (create) | First-run suggestions and weekdays |
| `src/lib/components/goals/ManageGoalsSheet.svelte` (create) | Settings sheet wiring commands |
| `src/lib/components/goals/TodayGoalsCard.svelte` (create) | Compact Overview card |
| `src/routes/dashboard/today/[[day]]/+page.ts` (create) | Rejects malformed day segments |
| `src/routes/dashboard/today/[[day]]/+page.svelte` (create) | Today page |
| `src/routes/dashboard/+layout.svelte` (modify) | Nav and command-palette entry |
| `src/routes/dashboard/+page.svelte` (modify) | Shows the Overview card |
| `vite.config.ts` (modify) | Pre-bundles the `undo-2` icon for browser tests |

---

### Task 1: Rules module

**Files:**
- Create: `src/lib/daily-goals.ts`
- Test: `src/lib/daily-goals.spec.ts`

**Interfaces:**
- Consumes: `dayNumber`, `dayFromNumber` from `src/lib/days.ts`.
- Produces (used by every later task):
  - `GOAL_UNITS`, `type GoalUnit = 'minutes' | 'reps' | 'seconds'`
  - `QUICK_AMOUNTS: Record<GoalUnit, readonly number[]>`, `MAX_AMOUNT = 10_000`, `HISTORY_DAYS = 84`, `WORKWEEK_MASK = 0b0011111`
  - `interface NewGoal { name: string; unit: GoalUnit; target: number }`
  - `type DayStatus = 'done' | 'missed' | 'in-progress' | 'rest'`
  - `interface TargetVersion { effectiveFrom: string; target: number }`
  - `interface GoalRules { id: string; archivedOn: string | null; targets: readonly TargetVersion[] }`
  - `interface ScheduleVersion { effectiveFrom: string; weekdays: number }`
  - `type DayTotals = ReadonlyMap<string, number>` (goal id → total)
  - `weekdayIndex(day: string): number` (Monday 0 … Sunday 6)
  - `targetOn(goal: GoalRules, day: string): number | null`
  - `scheduleOn(schedule: readonly ScheduleVersion[], day: string): number | null`
  - `isScheduled(schedule: readonly ScheduleVersion[], day: string): boolean`
  - `interface GoalCheck<G> { goal: G; target: number; total: number; met: boolean }`
  - `interface DayResult<G> { day: string; scheduled: boolean; status: DayStatus; allMet: boolean; goals: GoalCheck<G>[] }`
  - `evaluateDay<G extends GoalRules>(goals: readonly G[], schedule, totals: DayTotals | undefined, day, today): DayResult<G>`
  - `interface HistoryDay { day: string; status: DayStatus; allMet: boolean }`
  - `interface GoalHistory { days: HistoryDay[]; currentStreak: number; bestStreak: number }`
  - `firstGoalDay(goals: readonly GoalRules[]): string | null`
  - `summarizeHistory(goals, schedule, totalsByDay: ReadonlyMap<string, DayTotals>, today: string, days: number): GoalHistory`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/daily-goals.spec.ts`. Calendar reference: 2026-11-02 is a Monday and 2026-11-08 is a Sunday.

```ts
import { describe, expect, it } from 'vitest';
import {
	WORKWEEK_MASK,
	evaluateDay,
	isScheduled,
	scheduleOn,
	summarizeHistory,
	targetOn,
	weekdayIndex,
	type DayTotals,
	type GoalRules,
	type ScheduleVersion
} from './daily-goals';

const workweek: ScheduleVersion[] = [{ effectiveFrom: '2026-10-01', weekdays: WORKWEEK_MASK }];
const pushUps: GoalRules = {
	id: 'push',
	archivedOn: null,
	targets: [
		{ effectiveFrom: '2026-11-04', target: 120 },
		{ effectiveFrom: '2026-10-01', target: 100 }
	]
};
const walk: GoalRules = {
	id: 'walk',
	archivedOn: null,
	targets: [{ effectiveFrom: '2026-10-01', target: 60 }]
};
const totals = (entries: Record<string, number>): DayTotals => new Map(Object.entries(entries));

describe('weekdayIndex', () => {
	it('counts from Monday', () => {
		expect(weekdayIndex('2026-11-02')).toBe(0);
		expect(weekdayIndex('2026-11-08')).toBe(6);
	});
});

describe('targetOn', () => {
	it('uses the latest version on or before the day', () => {
		expect(targetOn(pushUps, '2026-09-30')).toBeNull();
		expect(targetOn(pushUps, '2026-11-03')).toBe(100);
		expect(targetOn(pushUps, '2026-11-04')).toBe(120);
	});

	it('stops on the archive day', () => {
		const archived = { ...walk, archivedOn: '2026-11-05' };
		expect(targetOn(archived, '2026-11-04')).toBe(60);
		expect(targetOn(archived, '2026-11-05')).toBeNull();
	});
});

describe('schedule', () => {
	it('follows the version in effect', () => {
		const schedule = [
			...workweek,
			{ effectiveFrom: '2026-11-07', weekdays: WORKWEEK_MASK | (1 << 5) }
		];
		expect(isScheduled(schedule, '2026-10-31')).toBe(false);
		expect(isScheduled(schedule, '2026-11-02')).toBe(true);
		expect(isScheduled(schedule, '2026-11-07')).toBe(true);
		expect(isScheduled(schedule, '2026-11-08')).toBe(false);
		expect(scheduleOn(schedule, '2026-11-07')).toBe(WORKWEEK_MASK | (1 << 5));
	});

	it('schedules nothing before the first version', () => {
		expect(isScheduled([], '2026-11-02')).toBe(false);
		expect(scheduleOn(workweek, '2026-09-30')).toBeNull();
	});
});

describe('evaluateDay', () => {
	const today = '2026-11-06';

	it('is done when every active goal is met on a scheduled day', () => {
		const result = evaluateDay(
			[pushUps, walk],
			workweek,
			totals({ push: 100, walk: 75 }),
			'2026-11-03',
			today
		);
		expect(result.status).toBe('done');
		expect(result.goals.map((check) => [check.goal.id, check.target, check.total, check.met])).toEqual([
			['push', 100, 100, true],
			['walk', 60, 75, true]
		]);
	});

	it('judges each day by the target it had', () => {
		const result = evaluateDay([pushUps], workweek, totals({ push: 100 }), '2026-11-04', today);
		expect(result.status).toBe('missed');
	});

	it('keeps today in progress until every goal is met', () => {
		expect(evaluateDay([pushUps, walk], workweek, totals({ push: 120 }), today, today).status).toBe(
			'in-progress'
		);
		expect(
			evaluateDay([pushUps, walk], workweek, totals({ push: 120, walk: 60 }), today, today).status
		).toBe('done');
	});

	it('marks unscheduled days as rest and notes when every goal was met', () => {
		expect(evaluateDay([walk], workweek, totals({ walk: 60 }), '2026-11-07', '2026-11-08')).toMatchObject({
			scheduled: false,
			status: 'rest',
			allMet: true
		});
		expect(evaluateDay([walk], workweek, undefined, '2026-11-08', '2026-11-08').status).toBe('rest');
	});

	it('counts a scheduled day without active goals as missed', () => {
		const archived = { ...walk, archivedOn: '2026-11-02' };
		expect(evaluateDay([archived], workweek, undefined, '2026-11-03', today)).toMatchObject({
			status: 'missed',
			allMet: false,
			goals: []
		});
	});

	it('leaves out goals that did not apply that day', () => {
		const plank: GoalRules = {
			id: 'plank',
			archivedOn: null,
			targets: [{ effectiveFrom: '2026-11-05', target: 120 }]
		};
		const result = evaluateDay([walk, plank], workweek, totals({ walk: 60 }), '2026-11-04', today);
		expect(result.goals.map((check) => check.goal.id)).toEqual(['walk']);
		expect(result.status).toBe('done');
	});
});

describe('summarizeHistory', () => {
	const goal: GoalRules = {
		id: 'walk',
		archivedOn: null,
		targets: [{ effectiveFrom: '2026-10-26', target: 60 }]
	};
	const schedule: ScheduleVersion[] = [{ effectiveFrom: '2026-10-26', weekdays: WORKWEEK_MASK }];
	const met = (...days: string[]) =>
		new Map<string, DayTotals>(days.map((day) => [day, totals({ walk: 60 })]));

	it('returns the window oldest first, ending today', () => {
		const history = summarizeHistory([goal], schedule, met(), '2026-11-08', 7);
		expect(history.days.map((day) => day.day)).toEqual([
			'2026-11-02',
			'2026-11-03',
			'2026-11-04',
			'2026-11-05',
			'2026-11-06',
			'2026-11-07',
			'2026-11-08'
		]);
	});

	it('keeps the streak across rest days and an unfinished today', () => {
		const history = summarizeHistory(
			[goal],
			schedule,
			met('2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'),
			'2026-11-06',
			14
		);
		expect(history.currentStreak).toBe(6);
		expect(history.bestStreak).toBe(6);
		expect(history.days.at(-1)).toEqual({ day: '2026-11-06', status: 'in-progress', allMet: false });
	});

	it('resets on a missed day and remembers the best run', () => {
		const history = summarizeHistory(
			[goal],
			schedule,
			met(
				'2026-10-26',
				'2026-10-27',
				'2026-10-28',
				'2026-10-29',
				'2026-10-30',
				'2026-11-03',
				'2026-11-04',
				'2026-11-05'
			),
			'2026-11-05',
			14
		);
		expect(history.currentStreak).toBe(3);
		expect(history.bestStreak).toBe(5);
	});

	it('does not count goals met on rest days', () => {
		const history = summarizeHistory(
			[goal],
			schedule,
			met('2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'),
			'2026-11-02',
			7
		);
		expect(history.currentStreak).toBe(2);
		expect(history.days.find((day) => day.day === '2026-10-31')).toEqual({
			day: '2026-10-31',
			status: 'rest',
			allMet: true
		});
	});

	it('has no streak without goals', () => {
		expect(summarizeHistory([], [], new Map(), '2026-11-08', 3)).toEqual({
			days: [
				{ day: '2026-11-06', status: 'rest', allMet: false },
				{ day: '2026-11-07', status: 'rest', allMet: false },
				{ day: '2026-11-08', status: 'rest', allMet: false }
			],
			currentStreak: 0,
			bestStreak: 0
		});
	});
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun run test:unit --run src/lib/daily-goals.spec.ts`
Expected: FAIL, because `./daily-goals` cannot be resolved.

- [ ] **Step 3: Implement the rules module**

Create `src/lib/daily-goals.ts`:

```ts
import { dayFromNumber, dayNumber } from '#lib/days.js';

/**
 * Rules for daily home goals: which goals and targets apply on a day, whether the day counts,
 * and streaks. Pure functions over `YYYY-MM-DD` dates, shared by the server and the UI.
 */

export const GOAL_UNITS = ['minutes', 'reps', 'seconds'] as const;
export type GoalUnit = (typeof GOAL_UNITS)[number];

/** Amounts offered as one-tap buttons for each unit. */
export const QUICK_AMOUNTS: Record<GoalUnit, readonly number[]> = {
	minutes: [5, 10, 15],
	reps: [5, 10, 20],
	seconds: [15, 30, 60]
};

/** Largest target or single entry, in the goal's unit. */
export const MAX_AMOUNT = 10_000;
/** Days in the history strip: twelve weeks ending today. */
export const HISTORY_DAYS = 84;
/** Monday to Friday; bit 0 is Monday. */
export const WORKWEEK_MASK = 0b0011111;

export interface NewGoal {
	name: string;
	unit: GoalUnit;
	target: number;
}

export type DayStatus = 'done' | 'missed' | 'in-progress' | 'rest';

export interface TargetVersion {
	/** First day this target applies. */
	effectiveFrom: string;
	target: number;
}

export interface GoalRules {
	id: string;
	/** The goal stops counting from this day onward. */
	archivedOn: string | null;
	targets: readonly TargetVersion[];
}

export interface ScheduleVersion {
	effectiveFrom: string;
	/** Bit 0 = Monday … bit 6 = Sunday. */
	weekdays: number;
}

/** Total logged per goal ID on one day; missing goals count as zero. */
export type DayTotals = ReadonlyMap<string, number>;

export interface GoalCheck<G> {
	goal: G;
	target: number;
	total: number;
	met: boolean;
}

export interface DayResult<G> {
	day: string;
	scheduled: boolean;
	status: DayStatus;
	/** At least one goal applied and every one was met, scheduled or not. */
	allMet: boolean;
	goals: GoalCheck<G>[];
}

export interface HistoryDay {
	day: string;
	status: DayStatus;
	allMet: boolean;
}

export interface GoalHistory {
	/** Oldest first, ending today. */
	days: HistoryDay[];
	currentStreak: number;
	bestStreak: number;
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(day: string): number {
	// 1970-01-01 was a Thursday, the fourth day of a Monday-based week.
	return (((dayNumber(day) + 3) % 7) + 7) % 7;
}

function latestOnOrBefore<T extends { effectiveFrom: string }>(
	versions: readonly T[],
	day: string
): T | undefined {
	let found: T | undefined;
	for (const version of versions) {
		if (version.effectiveFrom <= day && (found === undefined || version.effectiveFrom > found.effectiveFrom)) {
			found = version;
		}
	}
	return found;
}

/** The goal's target on `day`, or null when the goal does not apply that day. */
export function targetOn(goal: GoalRules, day: string): number | null {
	if (goal.archivedOn !== null && goal.archivedOn <= day) return null;
	return latestOnOrBefore(goal.targets, day)?.target ?? null;
}

/** The weekday mask in effect on `day`, or null before the first schedule. */
export function scheduleOn(schedule: readonly ScheduleVersion[], day: string): number | null {
	return latestOnOrBefore(schedule, day)?.weekdays ?? null;
}

export function isScheduled(schedule: readonly ScheduleVersion[], day: string): boolean {
	const weekdays = scheduleOn(schedule, day);
	return weekdays !== null && (weekdays & (1 << weekdayIndex(day))) !== 0;
}

export function evaluateDay<G extends GoalRules>(
	goals: readonly G[],
	schedule: readonly ScheduleVersion[],
	totals: DayTotals | undefined,
	day: string,
	today: string
): DayResult<G> {
	const checks: GoalCheck<G>[] = [];
	for (const goal of goals) {
		const target = targetOn(goal, day);
		if (target === null) continue;
		const total = totals?.get(goal.id) ?? 0;
		checks.push({ goal, target, total, met: total >= target });
	}
	const scheduled = isScheduled(schedule, day);
	const allMet = checks.length > 0 && checks.every((check) => check.met);
	let status: DayStatus;
	if (!scheduled) status = 'rest';
	else if (allMet) status = 'done';
	else if (day === today) status = 'in-progress';
	else status = 'missed';
	return { day, scheduled, status, allMet, goals: checks };
}

/** The first day any goal had a target, or null without goals. */
export function firstGoalDay(goals: readonly GoalRules[]): string | null {
	let first: string | null = null;
	for (const goal of goals) {
		for (const version of goal.targets) {
			if (first === null || version.effectiveFrom < first) first = version.effectiveFrom;
		}
	}
	return first;
}

/**
 * Day statuses for the `days` days ending `today`, and the streaks: runs of done days in which
 * rest days and an unfinished today are skipped and a missed day starts over.
 */
export function summarizeHistory(
	goals: readonly GoalRules[],
	schedule: readonly ScheduleVersion[],
	totalsByDay: ReadonlyMap<string, DayTotals>,
	today: string,
	days: number
): GoalHistory {
	const todayNumber = dayNumber(today);
	const evaluate = (n: number) => {
		const day = dayFromNumber(n);
		return evaluateDay(goals, schedule, totalsByDay.get(day), day, today);
	};

	const window: HistoryDay[] = [];
	for (let n = todayNumber - days + 1; n <= todayNumber; n++) {
		const { day, status, allMet } = evaluate(n);
		window.push({ day, status, allMet });
	}

	const first = firstGoalDay(goals);
	let run = 0;
	let best = 0;
	if (first !== null) {
		for (let n = dayNumber(first); n <= todayNumber; n++) {
			const { status } = evaluate(n);
			if (status === 'done') {
				run += 1;
				best = Math.max(best, run);
			} else if (status === 'missed') {
				run = 0;
			}
		}
	}
	// Rest days and an unfinished today never end a run, so the run still open is the current one.
	return { days: window, currentStreak: run, bestStreak: best };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun run test:unit --run src/lib/daily-goals.spec.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Format, lint and commit**

```bash
bunx prettier --write src/lib/daily-goals.ts src/lib/daily-goals.spec.ts
bunx eslint src/lib/daily-goals.ts src/lib/daily-goals.spec.ts
git add src/lib/daily-goals.ts src/lib/daily-goals.spec.ts
git commit -m "feat: add daily goal rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tables, migration and goal settings

**Files:**
- Modify: `src/lib/server/db/schema.ts` (imports at the top; new section after `workoutSet`)
- Generate: `drizzle/0003_daily_goals.sql`, `drizzle/meta/0003_snapshot.json`, `drizzle/meta/_journal.json`
- Create: `src/lib/server/daily-goals.ts`
- Test: `src/lib/server/daily-goals.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`GoalUnit`, `GoalRules`, `ScheduleVersion`, `NewGoal`, `targetOn`, `scheduleOn`); `Database` and `Executor` from `src/lib/server/db/types.ts`; `createTestDatabase` and `createUser` from `src/lib/server/testing/database.ts`.
- Produces:
  - Tables `dailyGoal`, `dailyGoalTarget`, `dailyGoalSchedule`, `dailyGoalEntry` exported from `schema.ts`
  - `class DailyGoalError extends Error { code: 'not-found' | 'future-day' | 'inactive-goal' | 'invalid-order' }`
  - `interface GoalSettingsItem { id: string; name: string; unit: GoalUnit; target: number }`
  - `interface GoalSettings { goals: GoalSettingsItem[]; weekdays: number | null }`
  - `createGoal(db, userId, today, input: NewGoal): Promise<string>` (returns the new ID)
  - `updateGoal(db, userId, today, goalId, changes: { name?: string; target?: number }): Promise<void>`
  - `reorderGoals(db, userId, goalIds: string[]): Promise<void>`
  - `archiveGoal(db, userId, today, goalId): Promise<void>`
  - `setSchedule(db, userId, today, weekdays: number): Promise<void>`
  - `listGoals(db, userId, today): Promise<GoalSettings>`
  - Internal helper `loadRules(db, userId)`, reused in Task 3

- [ ] **Step 1: Add the tables**

In `src/lib/server/db/schema.ts`, add `check` and `smallint` to the `drizzle-orm/pg-core` import (keep it alphabetical) and add this type import after the existing `../google-health/types` import:

```ts
import type { GoalUnit } from '../../daily-goals';
```

Then add this section after the `workoutSet` table, before the Google Health section:

```ts
// ---------------------------------------------------------------------------
// Daily home goals
// ---------------------------------------------------------------------------

const localDay = (name: string) => date(name, { mode: 'string' });

export const dailyGoal = pgTable(
	'daily_goal',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: ownerId(),
		name: text('name').notNull(),
		unit: text('unit').$type<GoalUnit>().notNull(),
		sortOrder: integer('sort_order').notNull(),
		// The goal stops counting from this local day onward; earlier days keep it.
		archivedOn: localDay('archived_on'),
		createdAt: instant('created_at').notNull().defaultNow()
	},
	(table) => [
		index('daily_goal_user_order_idx').on(table.userId, table.sortOrder),
		check('daily_goal_unit_check', sql`${table.unit} in ('minutes', 'reps', 'seconds')`)
	]
);

const goalId = () =>
	uuid('goal_id')
		.notNull()
		.references(() => dailyGoal.id, { onDelete: 'cascade' });

// Targets are versioned by day so changing one never rewrites how past days are judged.
export const dailyGoalTarget = pgTable(
	'daily_goal_target',
	{
		goalId: goalId(),
		effectiveFrom: localDay('effective_from').notNull(),
		target: integer('target').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.goalId, table.effectiveFrom] }),
		check('daily_goal_target_range', sql`${table.target} between 1 and 10000`)
	]
);

export const dailyGoalSchedule = pgTable(
	'daily_goal_schedule',
	{
		userId: ownerId(),
		effectiveFrom: localDay('effective_from').notNull(),
		// Bit 0 = Monday … bit 6 = Sunday.
		weekdays: smallint('weekdays').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.effectiveFrom] }),
		check('daily_goal_schedule_weekdays', sql`${table.weekdays} between 1 and 127`)
	]
);

export const dailyGoalEntry = pgTable(
	'daily_goal_entry',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		goalId: goalId(),
		userId: ownerId(),
		day: localDay('day').notNull(),
		amount: integer('amount').notNull(),
		// clock_timestamp() differs per statement, so undo always finds the newest entry.
		createdAt: instant('created_at')
			.notNull()
			.default(sql`clock_timestamp()`)
	},
	(table) => [
		index('daily_goal_entry_user_day_idx').on(table.userId, table.day),
		index('daily_goal_entry_goal_day_created_idx').on(table.goalId, table.day, table.createdAt),
		check('daily_goal_entry_amount_range', sql`${table.amount} between 1 and 10000`)
	]
);
```

- [ ] **Step 2: Generate the migration**

Run: `bun run db:generate --name daily_goals`
Expected: it creates `drizzle/0003_daily_goals.sql` containing `CREATE TABLE "daily_goal"`, `"daily_goal_target"`, `"daily_goal_schedule"` and `"daily_goal_entry"`, with the four check constraints, and updates `drizzle/meta/_journal.json`. It does not connect to a database. Open the SQL and confirm it contains only those creates, their foreign keys and their indexes.

- [ ] **Step 3: Write the failing settings tests**

Create `src/lib/server/daily-goals.spec.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKWEEK_MASK } from '#lib/daily-goals.js';
import { dailyGoalSchedule, dailyGoalTarget } from './db/schema';
import {
	archiveGoal,
	createGoal,
	listGoals,
	reorderGoals,
	setSchedule,
	updateGoal
} from './daily-goals';
import { createTestDatabase, createUser, type TestDatabase } from './testing/database';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.close();
});

// 2026-11-02 is a Monday.
const MONDAY = '2026-11-02';

describe('daily goal settings', () => {
	it('creates goals in order with a target from today', async () => {
		const { db } = database;
		const user = await createUser(db);
		const walk = await createGoal(db, user, MONDAY, {
			name: 'Walking pad',
			unit: 'minutes',
			target: 60
		});
		const push = await createGoal(db, user, MONDAY, { name: 'Push-ups', unit: 'reps', target: 100 });
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);

		expect(await listGoals(db, user, MONDAY)).toEqual({
			goals: [
				{ id: walk, name: 'Walking pad', unit: 'minutes', target: 60 },
				{ id: push, name: 'Push-ups', unit: 'reps', target: 100 }
			],
			weekdays: WORKWEEK_MASK
		});
	});

	it('versions target changes by day, keeping one row per day', async () => {
		const { db } = database;
		const user = await createUser(db);
		const goal = await createGoal(db, user, MONDAY, { name: 'Push-ups', unit: 'reps', target: 100 });
		await updateGoal(db, user, '2026-11-04', goal, { target: 110 });
		await updateGoal(db, user, '2026-11-04', goal, { target: 120 });
		await updateGoal(db, user, '2026-11-04', goal, { name: 'Diamond push-ups' });

		const rows = await db
			.select()
			.from(dailyGoalTarget)
			.where(eq(dailyGoalTarget.goalId, goal))
			.orderBy(asc(dailyGoalTarget.effectiveFrom));
		expect(rows.map((row) => [row.effectiveFrom, row.target])).toEqual([
			[MONDAY, 100],
			['2026-11-04', 120]
		]);
		expect((await listGoals(db, user, '2026-11-04')).goals).toEqual([
			{ id: goal, name: 'Diamond push-ups', unit: 'reps', target: 120 }
		]);
	});

	it('versions the schedule by day', async () => {
		const { db } = database;
		const user = await createUser(db);
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);
		await setSchedule(db, user, MONDAY, 0b0111111);
		await setSchedule(db, user, '2026-11-09', WORKWEEK_MASK);

		const rows = await db
			.select()
			.from(dailyGoalSchedule)
			.where(eq(dailyGoalSchedule.userId, user))
			.orderBy(asc(dailyGoalSchedule.effectiveFrom));
		expect(rows.map((row) => [row.effectiveFrom, row.weekdays])).toEqual([
			[MONDAY, 0b0111111],
			['2026-11-09', WORKWEEK_MASK]
		]);
		expect((await listGoals(db, user, '2026-11-05')).weekdays).toBe(0b0111111);
	});

	it('reorders goals and rejects orders that do not list every goal once', async () => {
		const { db } = database;
		const user = await createUser(db);
		const a = await createGoal(db, user, MONDAY, { name: 'A', unit: 'reps', target: 10 });
		const b = await createGoal(db, user, MONDAY, { name: 'B', unit: 'reps', target: 10 });
		const c = await createGoal(db, user, MONDAY, { name: 'C', unit: 'reps', target: 10 });

		await reorderGoals(db, user, [c, a, b]);
		expect((await listGoals(db, user, MONDAY)).goals.map((goal) => goal.id)).toEqual([c, a, b]);

		await expect(reorderGoals(db, user, [a, b])).rejects.toMatchObject({ code: 'invalid-order' });
		await expect(reorderGoals(db, user, [a, a, b])).rejects.toMatchObject({
			code: 'invalid-order'
		});
	});

	it('archives a goal from today', async () => {
		const { db } = database;
		const user = await createUser(db);
		const a = await createGoal(db, user, MONDAY, { name: 'A', unit: 'reps', target: 10 });
		const b = await createGoal(db, user, MONDAY, { name: 'B', unit: 'seconds', target: 60 });

		await archiveGoal(db, user, '2026-11-05', a);

		expect((await listGoals(db, user, '2026-11-05')).goals.map((goal) => goal.id)).toEqual([b]);
		await expect(updateGoal(db, user, '2026-11-05', a, { target: 5 })).rejects.toMatchObject({
			code: 'not-found'
		});
		await expect(archiveGoal(db, user, '2026-11-05', a)).rejects.toMatchObject({
			code: 'not-found'
		});
		await reorderGoals(db, user, [b]);
	});

	it('keeps users apart', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const other = await createUser(db);
		const goal = await createGoal(db, owner, MONDAY, { name: 'A', unit: 'reps', target: 10 });

		await expect(updateGoal(db, other, MONDAY, goal, { name: 'Mine' })).rejects.toMatchObject({
			code: 'not-found'
		});
		await expect(archiveGoal(db, other, MONDAY, goal)).rejects.toMatchObject({
			code: 'not-found'
		});
		await expect(reorderGoals(db, other, [goal])).rejects.toMatchObject({
			code: 'invalid-order'
		});
		expect(await listGoals(db, other, MONDAY)).toEqual({ goals: [], weekdays: null });
	});
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `bun run test:unit --run src/lib/server/daily-goals.spec.ts`
Expected: FAIL, because `./daily-goals` cannot be resolved.

- [ ] **Step 5: Implement the settings functions**

Create `src/lib/server/daily-goals.ts`:

```ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
	scheduleOn,
	targetOn,
	type GoalRules,
	type GoalUnit,
	type NewGoal,
	type ScheduleVersion
} from '#lib/daily-goals.js';
import { dailyGoal, dailyGoalSchedule, dailyGoalTarget } from './db/schema';
import type { Database, Executor } from './db/types';

export type DailyGoalErrorCode = 'not-found' | 'future-day' | 'inactive-goal' | 'invalid-order';

/** A rejected goal operation; remote functions turn it into a 404 or 400 response. */
export class DailyGoalError extends Error {
	constructor(
		readonly code: DailyGoalErrorCode,
		message: string
	) {
		super(message);
		this.name = 'DailyGoalError';
	}
}

export interface GoalSettingsItem {
	id: string;
	name: string;
	unit: GoalUnit;
	/** The target in effect today. */
	target: number;
}

export interface GoalSettings {
	/** Goals that are not archived, in display order. */
	goals: GoalSettingsItem[];
	/** Today's weekday mask, or null before the first schedule is set. */
	weekdays: number | null;
}

export interface StoredGoal extends GoalRules {
	name: string;
	unit: GoalUnit;
}

/** Every goal the user ever had, with all target versions, and the schedule versions. */
export async function loadRules(
	db: Executor,
	userId: string
): Promise<{ goals: StoredGoal[]; schedule: ScheduleVersion[] }> {
	const goalRows = await db
		.select({
			id: dailyGoal.id,
			name: dailyGoal.name,
			unit: dailyGoal.unit,
			archivedOn: dailyGoal.archivedOn
		})
		.from(dailyGoal)
		.where(eq(dailyGoal.userId, userId))
		.orderBy(asc(dailyGoal.sortOrder), asc(dailyGoal.createdAt));
	const targetRows = await db
		.select({
			goalId: dailyGoalTarget.goalId,
			effectiveFrom: dailyGoalTarget.effectiveFrom,
			target: dailyGoalTarget.target
		})
		.from(dailyGoalTarget)
		.innerJoin(dailyGoal, eq(dailyGoal.id, dailyGoalTarget.goalId))
		.where(eq(dailyGoal.userId, userId));
	const schedule = await db
		.select({
			effectiveFrom: dailyGoalSchedule.effectiveFrom,
			weekdays: dailyGoalSchedule.weekdays
		})
		.from(dailyGoalSchedule)
		.where(eq(dailyGoalSchedule.userId, userId));

	const goals = goalRows.map((row) => ({
		...row,
		targets: targetRows
			.filter((target) => target.goalId === row.id)
			.map(({ effectiveFrom, target }) => ({ effectiveFrom, target }))
	}));
	return { goals, schedule };
}

/** The user's goal, archived or not. */
export async function requireGoal(db: Executor, userId: string, goalId: string) {
	const [goal] = await db
		.select()
		.from(dailyGoal)
		.where(and(eq(dailyGoal.id, goalId), eq(dailyGoal.userId, userId)));
	if (goal === undefined) throw new DailyGoalError('not-found', 'Goal not found');
	return goal;
}

async function requireActiveGoal(db: Executor, userId: string, goalId: string) {
	const goal = await requireGoal(db, userId, goalId);
	if (goal.archivedOn !== null) throw new DailyGoalError('not-found', 'Goal not found');
	return goal;
}

async function upsertTarget(db: Executor, goalId: string, today: string, target: number) {
	await db
		.insert(dailyGoalTarget)
		.values({ goalId, effectiveFrom: today, target })
		.onConflictDoUpdate({
			target: [dailyGoalTarget.goalId, dailyGoalTarget.effectiveFrom],
			set: { target }
		});
}

export async function createGoal(
	db: Database,
	userId: string,
	today: string,
	input: NewGoal
): Promise<string> {
	return await db.transaction(async (tx) => {
		const [{ next }] = await tx
			.select({ next: sql<number>`coalesce(max(${dailyGoal.sortOrder}) + 1, 0)::int` })
			.from(dailyGoal)
			.where(eq(dailyGoal.userId, userId));
		const [goal] = await tx
			.insert(dailyGoal)
			.values({ userId, name: input.name, unit: input.unit, sortOrder: next })
			.returning({ id: dailyGoal.id });
		await upsertTarget(tx, goal.id, today, input.target);
		return goal.id;
	});
}

export async function updateGoal(
	db: Database,
	userId: string,
	today: string,
	goalId: string,
	changes: { name?: string; target?: number }
): Promise<void> {
	await db.transaction(async (tx) => {
		await requireActiveGoal(tx, userId, goalId);
		if (changes.name !== undefined) {
			await tx.update(dailyGoal).set({ name: changes.name }).where(eq(dailyGoal.id, goalId));
		}
		if (changes.target !== undefined) await upsertTarget(tx, goalId, today, changes.target);
	});
}

/** Sets the display order; `goalIds` must list every goal that is not archived exactly once. */
export async function reorderGoals(db: Database, userId: string, goalIds: string[]): Promise<void> {
	await db.transaction(async (tx) => {
		const rows = await tx
			.select({ id: dailyGoal.id })
			.from(dailyGoal)
			.where(and(eq(dailyGoal.userId, userId), isNull(dailyGoal.archivedOn)));
		const current = new Set(rows.map((row) => row.id));
		const complete =
			goalIds.length === current.size &&
			new Set(goalIds).size === goalIds.length &&
			goalIds.every((id) => current.has(id));
		if (!complete) {
			throw new DailyGoalError('invalid-order', 'The order must list every goal exactly once');
		}
		for (const [index, id] of goalIds.entries()) {
			await tx.update(dailyGoal).set({ sortOrder: index }).where(eq(dailyGoal.id, id));
		}
	});
}

export async function archiveGoal(
	db: Database,
	userId: string,
	today: string,
	goalId: string
): Promise<void> {
	await requireActiveGoal(db, userId, goalId);
	await db.update(dailyGoal).set({ archivedOn: today }).where(eq(dailyGoal.id, goalId));
}

export async function setSchedule(
	db: Database,
	userId: string,
	today: string,
	weekdays: number
): Promise<void> {
	await db
		.insert(dailyGoalSchedule)
		.values({ userId, effectiveFrom: today, weekdays })
		.onConflictDoUpdate({
			target: [dailyGoalSchedule.userId, dailyGoalSchedule.effectiveFrom],
			set: { weekdays }
		});
}

export async function listGoals(db: Database, userId: string, today: string): Promise<GoalSettings> {
	const { goals, schedule } = await loadRules(db, userId);
	const items: GoalSettingsItem[] = [];
	for (const goal of goals) {
		const target = targetOn(goal, today);
		if (goal.archivedOn === null && target !== null) {
			items.push({ id: goal.id, name: goal.name, unit: goal.unit, target });
		}
	}
	return { goals: items, weekdays: scheduleOn(schedule, today) };
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `bun run test:unit --run src/lib/server/daily-goals.spec.ts`
Expected: PASS (6 tests). The PGlite helper applies the new migration, so a failure here can also mean the migration is wrong.

- [ ] **Step 7: Format, lint and commit**

```bash
bunx prettier --write src/lib/server/db/schema.ts src/lib/server/daily-goals.ts src/lib/server/daily-goals.spec.ts
bunx eslint src/lib/server/db/schema.ts src/lib/server/daily-goals.ts src/lib/server/daily-goals.spec.ts
git add src/lib/server/db/schema.ts drizzle/ src/lib/server/daily-goals.ts src/lib/server/daily-goals.spec.ts
git commit -m "feat: store daily goals with versioned targets and schedule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Entries, day view and history

**Files:**
- Modify: `src/lib/server/daily-goals.ts`
- Test: `src/lib/server/daily-goals.spec.ts` (append)

**Interfaces:**
- Consumes: Task 1 (`evaluateDay`, `firstGoalDay`, `summarizeHistory`, `targetOn`, `DayStatus`, `DayTotals`, `GoalHistory`); Task 2 (`loadRules`, `requireGoal`, `DailyGoalError`, `StoredGoal`).
- Produces:
  - `interface GoalEntryView { id: string; amount: number; createdAt: number }`
  - `interface GoalProgress { id: string; name: string; unit: GoalUnit; target: number; total: number; met: boolean; entries: GoalEntryView[] }`
  - `interface GoalDay { day: string; today: string; scheduled: boolean; status: DayStatus; goals: GoalProgress[] }`
  - `addEntry(db, userId, today, input: { goalId: string; day: string; amount: number }): Promise<void>`
  - `undoLastEntry(db, userId, input: { goalId: string; day: string }): Promise<void>`
  - `loadGoalDay(db, userId, day, today): Promise<GoalDay>`
  - `loadGoalHistory(db, userId, today, days): Promise<GoalHistory>`

- [ ] **Step 1: Write the failing tests**

Extend the imports at the top of `src/lib/server/daily-goals.spec.ts` to:

```ts
import {
	addEntry,
	archiveGoal,
	createGoal,
	listGoals,
	loadGoalDay,
	loadGoalHistory,
	reorderGoals,
	setSchedule,
	undoLastEntry,
	updateGoal
} from './daily-goals';
```

Append:

```ts
describe('daily goal entries', () => {
	it('totals entries per goal and undoes the latest one', async () => {
		const { db } = database;
		const user = await createUser(db);
		const walk = await createGoal(db, user, MONDAY, {
			name: 'Walking pad',
			unit: 'minutes',
			target: 60
		});
		const push = await createGoal(db, user, MONDAY, { name: 'Push-ups', unit: 'reps', target: 100 });
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);
		const day = '2026-11-03';

		await addEntry(db, user, day, { goalId: walk, day, amount: 20 });
		await addEntry(db, user, day, { goalId: walk, day, amount: 15 });
		await addEntry(db, user, day, { goalId: push, day, amount: 100 });

		let view = await loadGoalDay(db, user, day, day);
		expect(view).toMatchObject({ day, today: day, scheduled: true, status: 'in-progress' });
		expect(
			view.goals.map((goal) => [
				goal.name,
				goal.total,
				goal.target,
				goal.met,
				goal.entries.map((entry) => entry.amount)
			])
		).toEqual([
			['Walking pad', 35, 60, false, [20, 15]],
			['Push-ups', 100, 100, true, [100]]
		]);

		await undoLastEntry(db, user, { goalId: walk, day });
		view = await loadGoalDay(db, user, day, day);
		expect(view.goals[0]).toMatchObject({ total: 20, entries: [{ amount: 20 }] });

		await undoLastEntry(db, user, { goalId: walk, day });
		await undoLastEntry(db, user, { goalId: walk, day });
		view = await loadGoalDay(db, user, day, day);
		expect(view.goals[0]).toMatchObject({ total: 0, entries: [] });
		expect(view.goals[1]).toMatchObject({ total: 100 });
	});

	it('rejects future days and goals that do not apply on the day', async () => {
		const { db } = database;
		const user = await createUser(db);
		const goal = await createGoal(db, user, MONDAY, { name: 'Plank', unit: 'seconds', target: 120 });

		await expect(
			addEntry(db, user, '2026-11-03', { goalId: goal, day: '2026-11-04', amount: 30 })
		).rejects.toMatchObject({ code: 'future-day' });
		await expect(
			addEntry(db, user, '2026-11-03', { goalId: goal, day: '2026-11-01', amount: 30 })
		).rejects.toMatchObject({ code: 'inactive-goal' });

		await archiveGoal(db, user, '2026-11-05', goal);
		await expect(
			addEntry(db, user, '2026-11-05', { goalId: goal, day: '2026-11-05', amount: 30 })
		).rejects.toMatchObject({ code: 'inactive-goal' });
		await addEntry(db, user, '2026-11-05', { goalId: goal, day: '2026-11-04', amount: 30 });
		expect((await loadGoalDay(db, user, '2026-11-04', '2026-11-05')).goals).toMatchObject([
			{ id: goal, total: 30 }
		]);
	});

	it('keeps entries private', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const other = await createUser(db);
		const goal = await createGoal(db, owner, MONDAY, { name: 'A', unit: 'reps', target: 10 });
		await addEntry(db, owner, MONDAY, { goalId: goal, day: MONDAY, amount: 10 });

		await expect(
			addEntry(db, other, MONDAY, { goalId: goal, day: MONDAY, amount: 5 })
		).rejects.toMatchObject({ code: 'not-found' });
		await undoLastEntry(db, other, { goalId: goal, day: MONDAY });

		expect((await loadGoalDay(db, owner, MONDAY, MONDAY)).goals[0]).toMatchObject({ total: 10 });
		expect((await loadGoalDay(db, other, MONDAY, MONDAY)).goals).toEqual([]);
	});

	it('summarizes history with streaks', async () => {
		const { db } = database;
		const user = await createUser(db);
		const goal = await createGoal(db, user, MONDAY, {
			name: 'Walking pad',
			unit: 'minutes',
			target: 30
		});
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);
		const logged: [string, number][] = [
			['2026-11-02', 30],
			['2026-11-03', 30],
			['2026-11-04', 10],
			['2026-11-05', 20],
			['2026-11-05', 10],
			['2026-11-06', 30]
		];
		for (const [day, amount] of logged) {
			await addEntry(db, user, '2026-11-08', { goalId: goal, day, amount });
		}

		const history = await loadGoalHistory(db, user, '2026-11-08', 7);
		expect(history.days.map((day) => day.status)).toEqual([
			'done',
			'done',
			'missed',
			'done',
			'done',
			'rest',
			'rest'
		]);
		expect(history.currentStreak).toBe(2);
		expect(history.bestStreak).toBe(2);
	});
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `bun run test:unit --run src/lib/server/daily-goals.spec.ts`
Expected: FAIL. `addEntry`, `loadGoalDay`, `loadGoalHistory` and `undoLastEntry` are not exported (TypeError: not a function). The six settings tests still pass.

- [ ] **Step 3: Implement entries and loaders**

In `src/lib/server/daily-goals.ts`, change the imports to:

```ts
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { dayFromNumber, dayNumber } from '#lib/days.js';
import {
	evaluateDay,
	firstGoalDay,
	scheduleOn,
	summarizeHistory,
	targetOn,
	type DayStatus,
	type DayTotals,
	type GoalHistory,
	type GoalRules,
	type GoalUnit,
	type NewGoal,
	type ScheduleVersion
} from '#lib/daily-goals.js';
import { dailyGoal, dailyGoalEntry, dailyGoalSchedule, dailyGoalTarget } from './db/schema';
import type { Database, Executor } from './db/types';
```

Append:

```ts
export interface GoalEntryView {
	id: string;
	amount: number;
	/** Milliseconds since the epoch. */
	createdAt: number;
}

export interface GoalProgress {
	id: string;
	name: string;
	unit: GoalUnit;
	/** The target in effect on the day shown. */
	target: number;
	total: number;
	met: boolean;
	/** That day's entries, oldest first. */
	entries: GoalEntryView[];
}

export interface GoalDay {
	day: string;
	today: string;
	scheduled: boolean;
	status: DayStatus;
	/** Goals that applied on the day, in display order. */
	goals: GoalProgress[];
}

export async function addEntry(
	db: Database,
	userId: string,
	today: string,
	input: { goalId: string; day: string; amount: number }
): Promise<void> {
	if (input.day > today) throw new DailyGoalError('future-day', 'Cannot log a future day');
	const goal = await requireGoal(db, userId, input.goalId);
	const targets = await db
		.select({ effectiveFrom: dailyGoalTarget.effectiveFrom, target: dailyGoalTarget.target })
		.from(dailyGoalTarget)
		.where(eq(dailyGoalTarget.goalId, goal.id));
	if (targetOn({ id: goal.id, archivedOn: goal.archivedOn, targets }, input.day) === null) {
		throw new DailyGoalError('inactive-goal', 'This goal does not apply on that day');
	}
	await db
		.insert(dailyGoalEntry)
		.values({ goalId: goal.id, userId, day: input.day, amount: input.amount });
}

/** Deletes the newest entry for the goal on the day; does nothing when there is none. */
export async function undoLastEntry(
	db: Database,
	userId: string,
	input: { goalId: string; day: string }
): Promise<void> {
	const [latest] = await db
		.select({ id: dailyGoalEntry.id })
		.from(dailyGoalEntry)
		.where(
			and(
				eq(dailyGoalEntry.userId, userId),
				eq(dailyGoalEntry.goalId, input.goalId),
				eq(dailyGoalEntry.day, input.day)
			)
		)
		.orderBy(desc(dailyGoalEntry.createdAt), desc(dailyGoalEntry.id))
		.limit(1);
	if (latest !== undefined) {
		await db.delete(dailyGoalEntry).where(eq(dailyGoalEntry.id, latest.id));
	}
}

export async function loadGoalDay(
	db: Database,
	userId: string,
	day: string,
	today: string
): Promise<GoalDay> {
	const { goals, schedule } = await loadRules(db, userId);
	const entries = await db
		.select({
			id: dailyGoalEntry.id,
			goalId: dailyGoalEntry.goalId,
			amount: dailyGoalEntry.amount,
			createdAt: dailyGoalEntry.createdAt
		})
		.from(dailyGoalEntry)
		.where(and(eq(dailyGoalEntry.userId, userId), eq(dailyGoalEntry.day, day)))
		.orderBy(asc(dailyGoalEntry.createdAt), asc(dailyGoalEntry.id));

	const totals = new Map<string, number>();
	for (const entry of entries) {
		totals.set(entry.goalId, (totals.get(entry.goalId) ?? 0) + entry.amount);
	}
	const result = evaluateDay(goals, schedule, totals, day, today);
	return {
		day,
		today,
		scheduled: result.scheduled,
		status: result.status,
		goals: result.goals.map(({ goal, target, total, met }) => ({
			id: goal.id,
			name: goal.name,
			unit: goal.unit,
			target,
			total,
			met,
			entries: entries
				.filter((entry) => entry.goalId === goal.id)
				.map((entry) => ({
					id: entry.id,
					amount: entry.amount,
					createdAt: entry.createdAt.getTime()
				}))
		}))
	};
}

export async function loadGoalHistory(
	db: Database,
	userId: string,
	today: string,
	days: number
): Promise<GoalHistory> {
	const { goals, schedule } = await loadRules(db, userId);
	// Streaks may reach back past the window, to the first goal.
	const windowStart = dayFromNumber(dayNumber(today) - days + 1);
	const first = firstGoalDay(goals);
	const from = first !== null && first < windowStart ? first : windowStart;

	const rows = await db
		.select({
			day: dailyGoalEntry.day,
			goalId: dailyGoalEntry.goalId,
			total: sql<number>`sum(${dailyGoalEntry.amount})::int`
		})
		.from(dailyGoalEntry)
		.where(
			and(
				eq(dailyGoalEntry.userId, userId),
				gte(dailyGoalEntry.day, from),
				lte(dailyGoalEntry.day, today)
			)
		)
		.groupBy(dailyGoalEntry.day, dailyGoalEntry.goalId);

	const totalsByDay = new Map<string, Map<string, number>>();
	for (const row of rows) {
		let totals = totalsByDay.get(row.day);
		if (totals === undefined) {
			totals = new Map();
			totalsByDay.set(row.day, totals);
		}
		totals.set(row.goalId, row.total);
	}
	return summarizeHistory(goals, schedule, totalsByDay as ReadonlyMap<string, DayTotals>, today, days);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `bun run test:unit --run src/lib/server/daily-goals.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Format, lint and commit**

```bash
bunx prettier --write src/lib/server/daily-goals.ts src/lib/server/daily-goals.spec.ts
bunx eslint src/lib/server/daily-goals.ts src/lib/server/daily-goals.spec.ts
git add src/lib/server/daily-goals.ts src/lib/server/daily-goals.spec.ts
git commit -m "feat: log daily goal entries and summarize streaks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Remote functions

**Files:**
- Create: `src/lib/remote/goals.remote.ts`

**Interfaces:**
- Consumes: Task 1 (`GOAL_UNITS`, `HISTORY_DAYS`, `MAX_AMOUNT`); Tasks 2–3 (every server function and `DailyGoalError`); `resolveTimeZone` and `localDate` from `src/lib/server/dashboard.ts`; `requireUserId`; `TIME_ZONE_COOKIE`.
- Produces (imported by the UI tasks):
  - `getGoalDay(day: string | null)` → `GoalDay & { timeZone: string }`
  - `getGoalHistory()` → `GoalHistory`
  - `getGoals()` → `GoalSettings`
  - Commands: `createGoal(NewGoal) → { id }`, `updateGoal({ goalId, name?, target? })`, `reorderGoals(string[])`, `archiveGoal(goalId)`, `setSchedule(weekdays)`, `addEntry({ goalId, day, amount })`, `undoLastEntry({ goalId, day })`
  - Clients request refreshes with `.updates(getGoalDay, getGoalHistory, getGoals)` (any subset). Every command calls `refreshGoalViews()`, which honours those requests through `requested(...)`.

Remote functions need a request context, so the repo doesn't unit test them (see `imports.remote.ts`). The validation, and the server logic it guards, are covered by Tasks 1–3. This task is checked with `bun run check` and `bun run lint` here, and in the browser in Task 9.

- [ ] **Step 1: Write the module**

Create `src/lib/remote/goals.remote.ts`:

```ts
import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { command, getRequestEvent, query, requested } from '$app/server';
import { GOAL_UNITS, HISTORY_DAYS, MAX_AMOUNT } from '#lib/daily-goals.js';
import { dayFromNumber, dayNumber } from '#lib/days.js';
import { localDate, resolveTimeZone } from '#lib/server/dashboard.js';
import { db } from '#lib/server/db/index.js';
import * as goals from '#lib/server/daily-goals.js';
import { requireUserId } from '#lib/server/session.js';
import { TIME_ZONE_COOKIE } from '#lib/time-zone.js';

const day = v.pipe(
	v.string(),
	v.isoDate(),
	v.check((value) => dayFromNumber(dayNumber(value)) === value, 'Invalid date')
);
const amount = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_AMOUNT));
const goalName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));
const goalId = v.pipe(v.string(), v.uuid());
const weekdays = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(127));

/** The signed-in user and their local today, from the time zone cookie. */
function context() {
	const userId = requireUserId();
	const timeZone = resolveTimeZone(getRequestEvent().cookies.get(TIME_ZONE_COOKIE));
	return { userId, timeZone, today: localDate(timeZone, new Date()) };
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		if (cause instanceof goals.DailyGoalError) {
			error(cause.code === 'not-found' ? 404 : 400, cause.message);
		}
		throw cause;
	}
}

/** Refreshes the goal views the client asked for, in the same response as the command. */
async function refreshGoalViews(): Promise<void> {
	await Promise.all([
		requested(getGoalDay, 4).refreshAll(),
		requested(getGoalHistory, 1).refreshAll(),
		requested(getGoals, 1).refreshAll()
	]);
}

/** One day's goals and progress; `null` means today. */
export const getGoalDay = query(v.nullable(day), async (requestedDay) => {
	const { userId, timeZone, today } = context();
	const target = requestedDay ?? today;
	if (target > today) error(400, 'Cannot show a future day');
	return { timeZone, ...(await goals.loadGoalDay(db, userId, target, today)) };
});

export const getGoalHistory = query(async () => {
	const { userId, today } = context();
	return await goals.loadGoalHistory(db, userId, today, HISTORY_DAYS);
});

export const getGoals = query(async () => {
	const { userId, today } = context();
	return await goals.listGoals(db, userId, today);
});

export const createGoal = command(
	v.object({ name: goalName, unit: v.picklist(GOAL_UNITS), target: amount }),
	async (input) => {
		const { userId, today } = context();
		const id = await guarded(() => goals.createGoal(db, userId, today, input));
		await refreshGoalViews();
		return { id };
	}
);

export const updateGoal = command(
	v.object({ goalId, name: v.optional(goalName), target: v.optional(amount) }),
	async ({ goalId: id, ...changes }) => {
		const { userId, today } = context();
		await guarded(() => goals.updateGoal(db, userId, today, id, changes));
		await refreshGoalViews();
	}
);

export const reorderGoals = command(v.pipe(v.array(goalId), v.maxLength(100)), async (ids) => {
	const { userId } = context();
	await guarded(() => goals.reorderGoals(db, userId, ids));
	await refreshGoalViews();
});

export const archiveGoal = command(goalId, async (id) => {
	const { userId, today } = context();
	await guarded(() => goals.archiveGoal(db, userId, today, id));
	await refreshGoalViews();
});

export const setSchedule = command(weekdays, async (mask) => {
	const { userId, today } = context();
	await goals.setSchedule(db, userId, today, mask);
	await refreshGoalViews();
});

export const addEntry = command(v.object({ goalId, day, amount }), async (input) => {
	const { userId, today } = context();
	await guarded(() => goals.addEntry(db, userId, today, input));
	await refreshGoalViews();
});

export const undoLastEntry = command(v.object({ goalId, day }), async (input) => {
	const { userId } = context();
	await goals.undoLastEntry(db, userId, input);
	await refreshGoalViews();
});
```

- [ ] **Step 2: Type-check and lint**

Run: `bun run check && bunx eslint src/lib/remote/goals.remote.ts`
Expected: 0 errors. If `requested(...).refreshAll()` doesn't type-check, compare against `node_modules/@sveltejs/kit/types/index.d.ts` (search for `export function requested`); the signature is `requested(query, limit)`, returning an object with `refreshAll(): Promise<void>`.

- [ ] **Step 3: Commit**

```bash
bunx prettier --write src/lib/remote/goals.remote.ts
git add src/lib/remote/goals.remote.ts
git commit -m "feat: expose daily goals through remote functions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Copy, labels and the goal card

**Files:**
- Modify: `messages/en.json`, `messages/es.json`
- Modify: `vite.config.ts` (the client test project's `optimizeDeps.include`)
- Create: `src/lib/components/goals/labels.ts`
- Create: `src/lib/components/goals/GoalCard.svelte`
- Test: `src/lib/components/goals/GoalCard.svelte.spec.ts`

**Interfaces:**
- Consumes: Task 1 (`QUICK_AMOUNTS`, `MAX_AMOUNT`, `GoalUnit`, `DayStatus`, `HistoryDay`); Task 3 (`GoalProgress` type).
- Produces:
  - `unitLabel(unit: GoalUnit): string` (short: "min", "reps", "s"); `unitName(unit: GoalUnit): string` (long: "Minutes", "Reps", "Seconds")
  - `statusLabel(status: DayStatus): string`; `historyDayLabel(day: HistoryDay): string`
  - `<GoalCard goal: GoalProgress, pending?: boolean, onadd: (amount: number) => void, onundo: () => void />`
  - Every Paraglide key listed below

- [ ] **Step 1: Add the copy**

Add these keys to `messages/en.json` before the closing `}`. Add a comma after the current last entry.

```json
	"nav_today": "Today",
	"goals_page_title": "Daily goals",
	"goals_previous_day": "Previous day",
	"goals_next_day": "Next day",
	"goals_back_to_today": "Back to today",
	"goals_status_done": "Done",
	"goals_status_missed": "Missed",
	"goals_status_in_progress": "In progress",
	"goals_status_rest": "Rest day",
	"goals_status_rest_met": "Rest day, goals met",
	"goals_rest_notice": "Rest day: logging is optional and doesn't affect your streak.",
	"goals_day_none": "No goals applied on this day.",
	"goals_progress": "{total} / {target} {unit}",
	"goals_met": "Goal met",
	"goals_add": "Add",
	"goals_undo": "Undo",
	"goals_custom_amount": "Custom amount for {name}",
	"goals_unit_minutes": "min",
	"goals_unit_reps": "reps",
	"goals_unit_seconds": "s",
	"goals_unit_name_minutes": "Minutes",
	"goals_unit_name_reps": "Reps",
	"goals_unit_name_seconds": "Seconds",
	"goals_current_streak": "Current streak",
	"goals_best_streak": "Best streak",
	"goals_streak_hint": "Scheduled days in a row with every goal met",
	"goals_history_title": "Last 12 weeks",
	"goals_empty_title": "Set your daily goals",
	"goals_empty_desc": "Pick a few things to do at home every workday, like minutes on the walking pad and a number of push-ups.",
	"goals_empty_cta": "Set up your daily goals",
	"goals_manage": "Manage goals",
	"goals_manage_desc": "Target changes apply from today. Past days keep the targets they had.",
	"goals_setup_intro": "Start from these suggestions and adjust them to what you do at home.",
	"goals_days_label": "Days that count",
	"goals_days_hint": "The other days are rest days.",
	"goals_list_title": "Goals",
	"goals_name": "Name",
	"goals_target": "Daily target",
	"goals_unit": "Unit",
	"goals_save": "Save",
	"goals_move_up": "Move {name} up",
	"goals_move_down": "Move {name} down",
	"goals_archive": "Archive",
	"goals_archive_title": "Archive {name}?",
	"goals_archive_desc": "It stops counting from today. Past days keep it.",
	"goals_cancel": "Cancel",
	"goals_add_goal": "Add goal",
	"goals_remove_named": "Remove {name}",
	"goals_setup_save": "Save goals",
	"goals_suggest_walking": "Walking pad",
	"goals_suggest_pushups": "Push-ups",
	"goals_suggest_plank": "Plank",
	"goals_action_error": "Couldn't save that. Try again.",
	"goals_card_title": "Today's goals",
	"goals_card_done": "{done} / {total} done",
	"goals_card_setup": "Set up daily goals",
	"goals_streak_short": "Streak: {count}"
```

Add the same keys to `messages/es.json`:

```json
	"nav_today": "Hoy",
	"goals_page_title": "Objetivos diarios",
	"goals_previous_day": "Día anterior",
	"goals_next_day": "Día siguiente",
	"goals_back_to_today": "Volver a hoy",
	"goals_status_done": "Completado",
	"goals_status_missed": "No completado",
	"goals_status_in_progress": "En curso",
	"goals_status_rest": "Día de descanso",
	"goals_status_rest_met": "Descanso, objetivos cumplidos",
	"goals_rest_notice": "Día de descanso: registrar es opcional y no afecta a tu racha.",
	"goals_day_none": "Ningún objetivo aplicaba este día.",
	"goals_progress": "{total} / {target} {unit}",
	"goals_met": "Objetivo cumplido",
	"goals_add": "Añadir",
	"goals_undo": "Deshacer",
	"goals_custom_amount": "Cantidad personalizada para {name}",
	"goals_unit_minutes": "min",
	"goals_unit_reps": "reps",
	"goals_unit_seconds": "s",
	"goals_unit_name_minutes": "Minutos",
	"goals_unit_name_reps": "Repeticiones",
	"goals_unit_name_seconds": "Segundos",
	"goals_current_streak": "Racha actual",
	"goals_best_streak": "Mejor racha",
	"goals_streak_hint": "Días programados seguidos con todos los objetivos cumplidos",
	"goals_history_title": "Últimas 12 semanas",
	"goals_empty_title": "Define tus objetivos diarios",
	"goals_empty_desc": "Elige algunas cosas que hacer en casa cada día laborable, como minutos en la cinta de andar y un número de flexiones.",
	"goals_empty_cta": "Configurar objetivos diarios",
	"goals_manage": "Gestionar objetivos",
	"goals_manage_desc": "Los cambios de objetivo se aplican desde hoy. Los días pasados conservan sus objetivos.",
	"goals_setup_intro": "Parte de estas sugerencias y ajústalas a lo que haces en casa.",
	"goals_days_label": "Días que cuentan",
	"goals_days_hint": "El resto son días de descanso.",
	"goals_list_title": "Objetivos",
	"goals_name": "Nombre",
	"goals_target": "Objetivo diario",
	"goals_unit": "Unidad",
	"goals_save": "Guardar",
	"goals_move_up": "Subir {name}",
	"goals_move_down": "Bajar {name}",
	"goals_archive": "Archivar",
	"goals_archive_title": "¿Archivar {name}?",
	"goals_archive_desc": "Deja de contar desde hoy. Los días pasados lo conservan.",
	"goals_cancel": "Cancelar",
	"goals_add_goal": "Añadir objetivo",
	"goals_remove_named": "Quitar {name}",
	"goals_setup_save": "Guardar objetivos",
	"goals_suggest_walking": "Cinta de andar",
	"goals_suggest_pushups": "Flexiones",
	"goals_suggest_plank": "Plancha",
	"goals_action_error": "No se ha podido guardar. Inténtalo de nuevo.",
	"goals_card_title": "Objetivos de hoy",
	"goals_card_done": "{done} / {total} completados",
	"goals_card_setup": "Configurar objetivos diarios",
	"goals_streak_short": "Racha: {count}"
```

Run: `bun run i18n`
Expected: it compiles without errors and `src/lib/paraglide/messages/_index.js` now exports `goals_add`.

- [ ] **Step 2: Add the labels helper**

Create `src/lib/components/goals/labels.ts`:

```ts
import type { DayStatus, GoalUnit, HistoryDay } from '#lib/daily-goals.js';
import * as m from '#lib/paraglide/messages.js';

/** Short unit after a number: "min", "reps", "s". */
export function unitLabel(unit: GoalUnit): string {
	if (unit === 'minutes') return m.goals_unit_minutes();
	if (unit === 'seconds') return m.goals_unit_seconds();
	return m.goals_unit_reps();
}

/** The unit on its own, for choosing one. */
export function unitName(unit: GoalUnit): string {
	if (unit === 'minutes') return m.goals_unit_name_minutes();
	if (unit === 'seconds') return m.goals_unit_name_seconds();
	return m.goals_unit_name_reps();
}

export function statusLabel(status: DayStatus): string {
	if (status === 'done') return m.goals_status_done();
	if (status === 'missed') return m.goals_status_missed();
	if (status === 'in-progress') return m.goals_status_in_progress();
	return m.goals_status_rest();
}

export function historyDayLabel(day: HistoryDay): string {
	return day.status === 'rest' && day.allMet ? m.goals_status_rest_met() : statusLabel(day.status);
}
```

- [ ] **Step 3: Write the failing component test**

Add `'@lucide/svelte/icons/undo-2'` to the client project's `optimizeDeps.include` list in `vite.config.ts`, after `'@lucide/svelte/icons/check'`.

Create `src/lib/components/goals/GoalCard.svelte.spec.ts`:

```ts
import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import GoalCard from './GoalCard.svelte';
import type { GoalProgress } from '#lib/server/daily-goals.js';

function goal(overrides: Partial<GoalProgress> = {}): GoalProgress {
	return {
		id: 'goal-1',
		name: 'Push-ups',
		unit: 'reps',
		target: 100,
		total: 40,
		met: false,
		entries: [{ id: 'entry-1', amount: 40, createdAt: 0 }],
		...overrides
	};
}

describe('GoalCard', () => {
	it('shows progress and the rep presets', async () => {
		render(GoalCard, { goal: goal(), onadd: () => {}, onundo: () => {} });

		await expect.element(page.getByText('40 / 100 reps')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '+5 reps' })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '+20 reps' })).toBeInTheDocument();
		await expect.element(page.getByText('Goal met')).not.toBeInTheDocument();
	});

	it('reports preset and custom amounts', async () => {
		const onadd = vi.fn();
		render(GoalCard, { goal: goal(), onadd, onundo: () => {} });

		await page.getByRole('button', { name: '+10 reps' }).click();
		await page.getByLabelText('Custom amount for Push-ups').fill('25');
		await page.getByRole('button', { name: 'Add', exact: true }).click();

		expect(onadd.mock.calls).toEqual([[10], [25]]);
	});

	it('uses minute presets and marks a met goal', async () => {
		render(GoalCard, {
			goal: goal({ name: 'Walking pad', unit: 'minutes', target: 60, total: 65, met: true }),
			onadd: () => {},
			onundo: () => {}
		});

		await expect.element(page.getByText('65 / 60 min')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '+15 min' })).toBeInTheDocument();
		await expect.element(page.getByText('Goal met')).toBeInTheDocument();
	});

	it('disables undo without entries and every action while pending', async () => {
		const screen = render(GoalCard, {
			goal: goal({ total: 0, entries: [] }),
			onadd: () => {},
			onundo: () => {}
		});
		await expect.element(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

		await screen.rerender({ goal: goal(), pending: true, onadd: () => {}, onundo: () => {} });
		await expect.element(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: '+5 reps' })).toBeDisabled();
	});
});
```

Run: `bun run test:unit --run src/lib/components/goals/GoalCard.svelte.spec.ts`
Expected: FAIL, because `./GoalCard.svelte` does not exist.

- [ ] **Step 4: Implement the card**

Create `src/lib/components/goals/GoalCard.svelte` (this code passed `svelte-autofixer` while planning; run it again after any change):

```svelte
<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { MAX_AMOUNT, QUICK_AMOUNTS } from '#lib/daily-goals.js';
	import type { GoalProgress } from '#lib/server/daily-goals.js';
	import { formatNumber } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import { unitLabel } from './labels.js';

	let {
		goal,
		pending = false,
		onadd,
		onundo
	}: {
		goal: GoalProgress;
		/** Disables every action while a write for this goal is in flight. */
		pending?: boolean;
		onadd: (amount: number) => void;
		onundo: () => void;
	} = $props();

	let custom = $state<number | null>(null);
	const customValid = $derived(
		custom !== null && Number.isInteger(custom) && custom >= 1 && custom <= MAX_AMOUNT
	);
	const unit = $derived(unitLabel(goal.unit));

	function addCustom(event: SubmitEvent) {
		event.preventDefault();
		if (custom === null || !customValid) return;
		onadd(custom);
		custom = null;
	}
</script>

<article class="flex flex-col gap-4 border-t border-rule pt-5" aria-labelledby="goal-{goal.id}">
	<header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h3 id="goal-{goal.id}" class="flex items-center gap-2 text-xl">
			{goal.name}
			{#if goal.met}
				<CheckIcon class="size-5 text-success" aria-hidden="true" />
				<span class="sr-only">{m.goals_met()}</span>
			{/if}
		</h3>
		<p class="text-sm text-ink-2 tabular-nums">
			{m.goals_progress({
				total: formatNumber(goal.total),
				target: formatNumber(goal.target),
				unit
			})}
		</p>
	</header>
	<Progress
		value={Math.min(goal.total, goal.target)}
		max={goal.target}
		class="h-2"
		aria-label={goal.name}
	/>
	<div class="flex flex-wrap items-center gap-2">
		{#each QUICK_AMOUNTS[goal.unit] as amount (amount)}
			<Button variant="outline" size="sm" disabled={pending} onclick={() => onadd(amount)}>
				+{formatNumber(amount)} {unit}
			</Button>
		{/each}
		<form class="flex items-center gap-2" onsubmit={addCustom}>
			<Input
				type="number"
				inputmode="numeric"
				min="1"
				max={MAX_AMOUNT}
				step="1"
				placeholder={unit}
				aria-label={m.goals_custom_amount({ name: goal.name })}
				class="h-8 w-24"
				bind:value={custom}
			/>
			<Button type="submit" variant="secondary" size="sm" disabled={pending || !customValid}>
				{m.goals_add()}
			</Button>
		</form>
		<Button
			variant="ghost"
			size="sm"
			class="ml-auto"
			disabled={pending || goal.entries.length === 0}
			onclick={onundo}
		>
			<Undo2Icon aria-hidden="true" />
			{m.goals_undo()}
		</Button>
	</div>
</article>
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `bun run test:unit --run src/lib/components/goals/GoalCard.svelte.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Format, lint and commit**

```bash
bunx prettier --write messages/ vite.config.ts src/lib/components/goals/
bunx eslint src/lib/components/goals/ vite.config.ts
git add messages/ vite.config.ts src/lib/components/goals/
git commit -m "feat: add goal card with quick-add and undo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Today page, history strip and navigation

**Files:**
- Create: `src/lib/components/goals/GoalHistoryStrip.svelte`
- Create: `src/routes/dashboard/today/[[day]]/+page.ts`
- Create: `src/routes/dashboard/today/[[day]]/+page.svelte`
- Modify: `src/routes/dashboard/+layout.svelte` (imports, `Section['href']` union, `sections` list)

**Interfaces:**
- Consumes: Task 1 (`weekdayIndex`, `HistoryDay`); Task 4 (`getGoalDay`, `getGoalHistory`, `getGoals`, `addEntry`, `undoLastEntry`); Task 5 (`GoalCard`, `statusLabel`, `historyDayLabel`, messages); `StatCard`; `browserTimeZone` and `rememberTimeZone`.
- Produces: the `/dashboard/today` and `/dashboard/today/YYYY-MM-DD` pages. Task 7 adds the settings sheet to this page.

- [ ] **Step 1: Add the route guard**

Create `src/routes/dashboard/today/[[day]]/+page.ts`:

```ts
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const load: PageLoad = ({ params }) => {
	if (params.day !== undefined && !DAY.test(params.day)) error(404, 'Not found');
	return {};
};
```

- [ ] **Step 2: Add the history strip**

Create `src/lib/components/goals/GoalHistoryStrip.svelte` (it passed `svelte-autofixer`):

```svelte
<script lang="ts">
	import { resolve } from '$app/paths';
	import { weekdayIndex, type HistoryDay } from '#lib/daily-goals.js';
	import { dayToDate } from '#lib/days.js';
	import { formatDate } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import { historyDayLabel } from './labels.js';

	let {
		days,
		today,
		selected
	}: {
		/** Consecutive days, oldest first, ending today. */
		days: readonly HistoryDay[];
		today: string;
		selected: string;
	} = $props();

	// One column per Monday-based week, one row per weekday; blank cells pad the first week.
	const padding = $derived(days.length === 0 ? 0 : weekdayIndex(days[0].day));

	const href = (day: string) =>
		day === today ? resolve('/dashboard/today') : resolve('/dashboard/today/[[day]]', { day });

	function cellClass(day: HistoryDay): string {
		if (day.status === 'done') return 'bg-sun';
		if (day.status === 'in-progress') return 'border-2 border-sun';
		if (day.status === 'missed') return 'bg-error/30';
		return day.allMet ? 'bg-day-3 ring-2 ring-sun/60 ring-inset' : 'bg-day-2';
	}

	const legend = $derived([
		{ className: 'bg-sun', label: m.goals_status_done() },
		{ className: 'bg-error/30', label: m.goals_status_missed() },
		{ className: 'bg-day-2', label: m.goals_status_rest() },
		{ className: 'bg-day-3 ring-2 ring-sun/60 ring-inset', label: m.goals_status_rest_met() }
	]);
</script>

<div class="flex flex-col gap-3">
	<div class="grid w-max grid-flow-col grid-rows-7 gap-1">
		{#each { length: padding }, index (index)}
			<span class="size-4 sm:size-5" aria-hidden="true"></span>
		{/each}
		{#each days as day (day.day)}
			<a
				href={href(day.day)}
				class={cn(
					'size-4 rounded-[2px] outline-offset-2 sm:size-5',
					cellClass(day),
					day.day === selected && 'outline-2 outline-foreground'
				)}
				aria-current={day.day === selected ? 'date' : undefined}
				aria-label={`${formatDate(dayToDate(day.day).getTime(), { weekday: 'short', day: 'numeric', month: 'short' })}: ${historyDayLabel(day)}`}
			></a>
		{/each}
	</div>
	<ul class="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-3">
		{#each legend as item (item.label)}
			<li class="flex items-center gap-1.5">
				<span class={cn('size-3 rounded-[2px]', item.className)} aria-hidden="true"></span>
				{item.label}
			</li>
		{/each}
	</ul>
</div>
```

- [ ] **Step 3: Add the page**

Create `src/routes/dashboard/today/[[day]]/+page.svelte`. It passed `svelte-autofixer`; the remaining advisory notes about the `$effect` refer to the same time-zone pattern as `src/routes/dashboard/+page.svelte`, which writes a cookie and refreshes queries without assigning state. The `ManageGoalsSheet` import and markup at the end come in Task 7. For now, leave out the `ManageGoalsSheet` import and the final `{#if settings !== undefined}` block, and keep the `manageOpen` state so the buttons compile.

```svelte
<script lang="ts">
	import { browser } from '$app/env';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import {
		addEntry,
		getGoalDay,
		getGoalHistory,
		getGoals,
		undoLastEntry
	} from '#lib/remote/goals.remote.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import StatCard from '#lib/components/dashboard/StatCard.svelte';
	import GoalCard from '#lib/components/goals/GoalCard.svelte';
	import GoalHistoryStrip from '#lib/components/goals/GoalHistoryStrip.svelte';
	import ManageGoalsSheet from '#lib/components/goals/ManageGoalsSheet.svelte';
	import { statusLabel } from '#lib/components/goals/labels.js';
	import { dayFromNumber, dayNumber, dayToDate } from '#lib/days.js';
	import { formatDate, formatNumber } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import { browserTimeZone, rememberTimeZone } from '#lib/time-zone.js';
	import { cn } from '#lib/utils.js';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import TargetIcon from '@lucide/svelte/icons/target';

	// Without the time zone cookie the server would date "today" in UTC; wait for the browser to
	// set it, as the overview does.
	const ready = $derived(page.data.timeZoneKnown || browser);
	const dayQuery = $derived(ready ? getGoalDay(page.params.day ?? null) : null);
	const historyQuery = $derived(ready ? getGoalHistory() : null);
	const settingsQuery = $derived(ready ? getGoals() : null);

	const goalDay = $derived(dayQuery?.current);
	const history = $derived(historyQuery?.current);
	const settings = $derived(settingsQuery?.current);
	const hasError = $derived(
		dayQuery?.error !== undefined ||
			historyQuery?.error !== undefined ||
			settingsQuery?.error !== undefined
	);

	let timeZoneChecked = false;
	$effect(() => {
		if (goalDay === undefined || timeZoneChecked) return;
		timeZoneChecked = true;
		const timeZone = browserTimeZone();
		if (goalDay.timeZone !== timeZone) {
			rememberTimeZone(timeZone);
			void dayQuery?.refresh();
			void historyQuery?.refresh();
			void settingsQuery?.refresh();
		}
	});

	const isToday = $derived(goalDay !== undefined && goalDay.day === goalDay.today);
	const heading = $derived(
		goalDay === undefined || isToday
			? m.nav_today()
			: formatDate(dayToDate(goalDay.day).getTime(), {
					weekday: 'long',
					day: 'numeric',
					month: 'long'
				})
	);

	function dayHref(day: string, today: string) {
		return day === today ? resolve('/dashboard/today') : resolve('/dashboard/today/[[day]]', { day });
	}

	let pendingGoal = $state<string | null>(null);
	let manageOpen = $state(false);

	async function write(goalId: string, work: () => Promise<unknown>) {
		pendingGoal = goalId;
		try {
			await work();
		} catch {
			toast.error(m.goals_action_error());
		} finally {
			pendingGoal = null;
		}
	}

	function add(goalId: string, day: string, amount: number) {
		void write(goalId, () => addEntry({ goalId, day, amount }).updates(getGoalDay, getGoalHistory));
	}

	function undo(goalId: string, day: string) {
		void write(goalId, () => undoLastEntry({ goalId, day }).updates(getGoalDay, getGoalHistory));
	}
</script>

<svelte:head>
	<title>{m.goals_page_title()}: {m.app_name()}</title>
</svelte:head>

{#if hasError}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.data_error_title()}</Empty.Title>
			<Empty.Description>{m.data_error_description()}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a href={resolve('/dashboard/today')} class={buttonVariants({ variant: 'outline' })}>
				{m.goals_back_to_today()}
			</a>
		</Empty.Content>
	</Empty.Root>
{:else if goalDay === undefined || history === undefined || settings === undefined}
	<div class="flex flex-col gap-6 pt-7" aria-busy="true">
		<Skeleton class="h-10 w-48" />
		<Skeleton class="h-28 w-full" />
		<Skeleton class="h-28 w-full" />
	</div>
{:else if settings.goals.length === 0 && goalDay.goals.length === 0}
	<div class="pt-7">
		<h1 class="text-4xl">{heading}</h1>
	</div>
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><TargetIcon /></Empty.Media>
			<Empty.Title>{m.goals_empty_title()}</Empty.Title>
			<Empty.Description>{m.goals_empty_desc()}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button onclick={() => (manageOpen = true)}>{m.goals_empty_cta()}</Button>
		</Empty.Content>
	</Empty.Root>
{:else}
	{@const previous = dayFromNumber(dayNumber(goalDay.day) - 1)}
	{@const next = dayFromNumber(dayNumber(goalDay.day) + 1)}
	<div class="flex flex-col gap-4 pt-7 sm:flex-row sm:items-end sm:justify-between">
		<div class="flex flex-col gap-2">
			<div class="flex items-center gap-1">
				<a
					href={dayHref(previous, goalDay.today)}
					class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
					aria-label={m.goals_previous_day()}
				>
					<ChevronLeftIcon />
				</a>
				{#if isToday}
					<span
						class={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'opacity-40')}
						aria-hidden="true"
					>
						<ChevronRightIcon />
					</span>
				{:else}
					<a
						href={dayHref(next, goalDay.today)}
						class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
						aria-label={m.goals_next_day()}
					>
						<ChevronRightIcon />
					</a>
				{/if}
				<h1 class="ml-1 text-4xl">{heading}</h1>
			</div>
			<p class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
				<span
					class={cn(
						'rounded-(--radius-control) px-2 py-0.5 text-ink-2',
						goalDay.status === 'done' ? 'bg-sun text-white' : 'bg-day-2'
					)}
				>
					{statusLabel(goalDay.status)}
				</span>
				{#if !isToday}
					<a href={resolve('/dashboard/today')} class="underline underline-offset-2">
						{m.goals_back_to_today()}
					</a>
				{/if}
			</p>
		</div>
		<Button variant="outline" onclick={() => (manageOpen = true)}>{m.goals_manage()}</Button>
	</div>

	{#if goalDay.status === 'rest'}
		<p class="mt-6 text-sm text-ink-3">{m.goals_rest_notice()}</p>
	{/if}

	<section class="mt-8 flex flex-col gap-8" aria-label={m.goals_page_title()}>
		{#each goalDay.goals as goal (goal.id)}
			<GoalCard
				{goal}
				pending={pendingGoal === goal.id}
				onadd={(amount) => add(goal.id, goalDay.day, amount)}
				onundo={() => undo(goal.id, goalDay.day)}
			/>
		{:else}
			<p class="text-sm text-ink-3">{m.goals_day_none()}</p>
		{/each}
	</section>

	<section
		class="mt-16 grid gap-10 border-t border-rule pt-8 lg:grid-cols-[auto_minmax(0,1fr)]"
		aria-labelledby="goal-history-title"
	>
		<div class="flex flex-col gap-4">
			<h2 id="goal-history-title" class="text-2xl">{m.goals_history_title()}</h2>
			<GoalHistoryStrip days={history.days} today={goalDay.today} selected={goalDay.day} />
		</div>
		<dl class="flex flex-wrap gap-x-14 gap-y-8 lg:justify-end">
			<StatCard
				title={m.goals_current_streak()}
				value={formatNumber(history.currentStreak)}
				subtitle={m.goals_streak_hint()}
			/>
			<StatCard title={m.goals_best_streak()} value={formatNumber(history.bestStreak)} />
		</dl>
	</section>
{/if}

{#if settings !== undefined}
	<ManageGoalsSheet {settings} bind:open={manageOpen} />
{/if}
```

- [ ] **Step 4: Add the navigation entry**

In `src/routes/dashboard/+layout.svelte`:

1. Add `import TargetIcon from '@lucide/svelte/icons/target';` after the `HeartPulseIcon` import.
2. Change the `Section` type's `href` to:

```ts
		href:
			| '/dashboard'
			| '/dashboard/today'
			| '/dashboard/exercises'
			| '/dashboard/health'
			| '/dashboard/import';
```

3. In `sections`, add this line right after the Overview entry:

```ts
		{ href: '/dashboard/today', label: m.nav_today(), icon: TargetIcon },
```

The command palette is built from `sections`, so it picks up the entry automatically. `isActive` uses `startsWith`, so `/dashboard/today/2026-11-07` also highlights it.

- [ ] **Step 5: Type-check, lint and autofix**

Run `svelte-autofixer` (async true, version 5.57.2) on both new `.svelte` files until it reports no issues, then:

Run: `bun run check && bun run lint`
Expected: 0 errors and 0 warnings. If `resolve('/dashboard/today')` is rejected because only the optional-segment route ID is known, use `resolve('/dashboard/today/[[day]]', {})` in `dayHref`, the history strip and the layout instead, and run `bun run check` again.

- [ ] **Step 6: Commit**

```bash
bunx prettier --write src/routes/dashboard/ src/lib/components/goals/
git add src/routes/dashboard/ src/lib/components/goals/GoalHistoryStrip.svelte
git commit -m "feat: add the Today page with goal progress and history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Manage goals sheet and first-run setup

**Files:**
- Create: `src/lib/components/goals/WeekdayPicker.svelte`
- Create: `src/lib/components/goals/GoalSettingsRow.svelte`
- Create: `src/lib/components/goals/AddGoalForm.svelte`
- Create: `src/lib/components/goals/GoalSetupForm.svelte`
- Create: `src/lib/components/goals/ManageGoalsSheet.svelte`
- Modify: `src/routes/dashboard/today/[[day]]/+page.svelte` (restore the `ManageGoalsSheet` import and the final `{#if settings !== undefined}` block from Task 6)

**Interfaces:**
- Consumes: Task 1 (`GOAL_UNITS`, `MAX_AMOUNT`, `WORKWEEK_MASK`, `GoalUnit`, `NewGoal`); Task 2 (`GoalSettings`, `GoalSettingsItem` types); Task 4 (`createGoal`, `updateGoal`, `reorderGoals`, `archiveGoal`, `setSchedule`, `getGoalDay`, `getGoalHistory`, `getGoals`); Task 5 (`unitLabel`, `unitName`, messages).
- Produces: `<ManageGoalsSheet settings: GoalSettings bind:open />`

All five components passed `svelte-autofixer` while planning.

- [ ] **Step 1: Weekday picker**

Create `src/lib/components/goals/WeekdayPicker.svelte`:

```svelte
<script lang="ts">
	import { dayFromNumber, dayNumber, dayToDate } from '#lib/days.js';
	import { formatDate } from '#lib/format.js';
	import { cn } from '#lib/utils.js';

	let {
		value,
		label,
		disabled = false,
		onchange
	}: {
		/** Weekday mask, bit 0 = Monday … bit 6 = Sunday. */
		value: number;
		label: string;
		disabled?: boolean;
		onchange: (mask: number) => void;
	} = $props();

	// 2026-11-02 is a Monday; naming the week from a real date keeps the labels in the UI locale.
	const MONDAY = dayNumber('2026-11-02');
	const names = Array.from({ length: 7 }, (_, index) => {
		const date = dayToDate(dayFromNumber(MONDAY + index)).getTime();
		return {
			index,
			short: formatDate(date, { weekday: 'narrow' }),
			long: formatDate(date, { weekday: 'long' })
		};
	});

	function toggle(index: number) {
		const next = value ^ (1 << index);
		// At least one day must count.
		if (next !== 0) onchange(next);
	}
</script>

<div class="flex gap-1.5" role="group" aria-label={label}>
	{#each names as day (day.index)}
		{@const on = (value & (1 << day.index)) !== 0}
		<button
			type="button"
			class={cn(
				'flex size-10 items-center justify-center rounded-(--radius-control) border text-sm transition-colors duration-(--dur-micro) disabled:opacity-55',
				on
					? 'border-sun bg-sun text-white'
					: 'border-rule-2 text-ink-2 hover:border-field-edge hover:text-foreground'
			)}
			aria-pressed={on}
			aria-label={day.long}
			{disabled}
			onclick={() => toggle(day.index)}
		>
			{day.short}
		</button>
	{/each}
</div>
```

- [ ] **Step 2: Settings row**

Create `src/lib/components/goals/GoalSettingsRow.svelte`:

```svelte
<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MAX_AMOUNT } from '#lib/daily-goals.js';
	import type { GoalSettingsItem } from '#lib/server/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import { unitLabel } from './labels.js';

	let {
		goal,
		first,
		last,
		pending = false,
		onsave,
		onmove,
		onarchive
	}: {
		goal: GoalSettingsItem;
		first: boolean;
		last: boolean;
		pending?: boolean;
		onsave: (changes: { name?: string; target?: number }) => void;
		onmove: (offset: -1 | 1) => void;
		onarchive: () => void;
	} = $props();

	// Editable copies that reset whenever the saved goal changes.
	let name = $derived(goal.name);
	let target = $derived<number | null>(goal.target);

	const trimmed = $derived(name.trim());
	const valid = $derived(
		trimmed.length >= 1 &&
			trimmed.length <= 100 &&
			target !== null &&
			Number.isInteger(target) &&
			target >= 1 &&
			target <= MAX_AMOUNT
	);
	const dirty = $derived(trimmed !== goal.name || target !== goal.target);

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!valid || !dirty || target === null) return;
		onsave({
			...(trimmed !== goal.name ? { name: trimmed } : {}),
			...(target !== goal.target ? { target } : {})
		});
	}
</script>

<li class="flex flex-col gap-2 border-t border-rule pt-3">
	<form class="flex flex-wrap items-end gap-2" onsubmit={save}>
		<label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-3">
			{m.goals_name()}
			<Input bind:value={name} maxlength={100} class="h-9" />
		</label>
		<label class="flex w-28 flex-col gap-1 text-xs text-ink-3">
			{m.goals_target()} ({unitLabel(goal.unit)})
			<Input type="number" min="1" max={MAX_AMOUNT} step="1" bind:value={target} class="h-9" />
		</label>
		{#if dirty}
			<Button type="submit" size="sm" class="h-9" disabled={pending || !valid}>
				{m.goals_save()}
			</Button>
		{/if}
	</form>
	<div class="flex items-center gap-1">
		<Button
			variant="ghost"
			size="icon-sm"
			disabled={pending || first}
			aria-label={m.goals_move_up({ name: goal.name })}
			onclick={() => onmove(-1)}
		>
			<ArrowUpIcon />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			disabled={pending || last}
			aria-label={m.goals_move_down({ name: goal.name })}
			onclick={() => onmove(1)}
		>
			<ArrowDownIcon />
		</Button>
		<AlertDialog.Root>
			<AlertDialog.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'sm', class: 'ml-auto' })}
				disabled={pending}
			>
				{m.goals_archive()}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>{m.goals_archive_title({ name: goal.name })}</AlertDialog.Title>
					<AlertDialog.Description>{m.goals_archive_desc()}</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel>{m.goals_cancel()}</AlertDialog.Cancel>
					<AlertDialog.Action onclick={onarchive}>{m.goals_archive()}</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</div>
</li>
```

- [ ] **Step 3: Add-goal form**

Create `src/lib/components/goals/AddGoalForm.svelte`:

```svelte
<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { GOAL_UNITS, MAX_AMOUNT, type GoalUnit, type NewGoal } from '#lib/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import { unitName } from './labels.js';

	let {
		pending = false,
		onadd
	}: {
		pending?: boolean;
		/** Resolves true when the goal was saved, which clears the form. */
		onadd: (goal: NewGoal) => Promise<boolean>;
	} = $props();

	let name = $state('');
	let unit = $state<GoalUnit>('reps');
	let target = $state<number | null>(null);

	const trimmed = $derived(name.trim());
	const valid = $derived(
		trimmed.length >= 1 &&
			trimmed.length <= 100 &&
			target !== null &&
			Number.isInteger(target) &&
			target >= 1 &&
			target <= MAX_AMOUNT
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!valid || target === null) return;
		if (await onadd({ name: trimmed, unit, target })) {
			name = '';
			target = null;
		}
	}
</script>

<form class="flex flex-col gap-3" onsubmit={submit}>
	<label class="flex flex-col gap-1 text-xs text-ink-3">
		{m.goals_name()}
		<Input bind:value={name} maxlength={100} class="h-9" />
	</label>
	<div class="flex flex-col gap-1 text-xs text-ink-3">
		<span id="new-goal-unit">{m.goals_unit()}</span>
		<div class="flex gap-1.5" role="group" aria-labelledby="new-goal-unit">
			{#each GOAL_UNITS as option (option)}
				<button
					type="button"
					class={cn(
						'h-9 flex-1 rounded-(--radius-control) border text-sm transition-colors duration-(--dur-micro)',
						unit === option
							? 'border-sun bg-sun text-white'
							: 'border-rule-2 text-ink-2 hover:border-field-edge hover:text-foreground'
					)}
					aria-pressed={unit === option}
					onclick={() => (unit = option)}
				>
					{unitName(option)}
				</button>
			{/each}
		</div>
	</div>
	<label class="flex flex-col gap-1 text-xs text-ink-3">
		{m.goals_target()}
		<Input type="number" min="1" max={MAX_AMOUNT} step="1" bind:value={target} class="h-9" />
	</label>
	<Button type="submit" disabled={pending || !valid}>{m.goals_add_goal()}</Button>
</form>
```

- [ ] **Step 4: First-run setup form**

Create `src/lib/components/goals/GoalSetupForm.svelte`:

```svelte
<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MAX_AMOUNT, WORKWEEK_MASK, type GoalUnit, type NewGoal } from '#lib/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import XIcon from '@lucide/svelte/icons/x';
	import WeekdayPicker from './WeekdayPicker.svelte';
	import { unitLabel, unitName } from './labels.js';

	let {
		pending = false,
		onsave
	}: {
		pending?: boolean;
		onsave: (goals: NewGoal[], weekdays: number) => void;
	} = $props();

	let nextKey = 3;
	let drafts = $state<{ key: number; name: string; unit: GoalUnit; target: number | null }[]>([
		{ key: 0, name: m.goals_suggest_walking(), unit: 'minutes', target: 60 },
		{ key: 1, name: m.goals_suggest_pushups(), unit: 'reps', target: 100 },
		{ key: 2, name: m.goals_suggest_plank(), unit: 'seconds', target: 120 }
	]);
	let weekdays = $state(WORKWEEK_MASK);

	const valid = $derived(
		drafts.length > 0 &&
			drafts.every(
				(draft) =>
					draft.name.trim().length >= 1 &&
					draft.name.trim().length <= 100 &&
					draft.target !== null &&
					Number.isInteger(draft.target) &&
					draft.target >= 1 &&
					draft.target <= MAX_AMOUNT
			)
	);

	function addDraft(unit: GoalUnit) {
		drafts.push({ key: nextKey++, name: '', unit, target: null });
	}

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!valid) return;
		onsave(
			drafts.map((draft) => ({
				name: draft.name.trim(),
				unit: draft.unit,
				target: draft.target ?? 0
			})),
			weekdays
		);
	}
</script>

<form class="flex flex-col gap-6" onsubmit={save}>
	<p class="text-sm text-ink-2">{m.goals_setup_intro()}</p>
	<ul class="flex flex-col gap-3">
		{#each drafts as draft, index (draft.key)}
			<li class="flex items-end gap-2">
				<label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-3">
					{m.goals_name()}
					<Input bind:value={draft.name} maxlength={100} class="h-9" />
				</label>
				<label class="flex w-28 flex-col gap-1 text-xs text-ink-3">
					{m.goals_target()} ({unitLabel(draft.unit)})
					<Input
						type="number"
						min="1"
						max={MAX_AMOUNT}
						step="1"
						bind:value={draft.target}
						class="h-9"
					/>
				</label>
				<Button
					variant="ghost"
					size="icon"
					aria-label={m.goals_remove_named({ name: draft.name || unitName(draft.unit) })}
					onclick={() => drafts.splice(index, 1)}
				>
					<XIcon />
				</Button>
			</li>
		{/each}
	</ul>
	<div class="flex flex-wrap items-center gap-2 text-sm text-ink-3">
		{m.goals_add_goal()}:
		<Button variant="outline" size="sm" onclick={() => addDraft('minutes')}>
			{unitName('minutes')}
		</Button>
		<Button variant="outline" size="sm" onclick={() => addDraft('reps')}>
			{unitName('reps')}
		</Button>
		<Button variant="outline" size="sm" onclick={() => addDraft('seconds')}>
			{unitName('seconds')}
		</Button>
	</div>
	<div class="flex flex-col gap-2">
		<p class="text-sm text-ink-2">{m.goals_days_label()}</p>
		<WeekdayPicker
			value={weekdays}
			label={m.goals_days_label()}
			onchange={(mask) => (weekdays = mask)}
		/>
		<p class="text-xs text-ink-3">{m.goals_days_hint()}</p>
	</div>
	<Button type="submit" disabled={pending || !valid}>{m.goals_setup_save()}</Button>
</form>
```

- [ ] **Step 5: The sheet**

Create `src/lib/components/goals/ManageGoalsSheet.svelte`:

```svelte
<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import type { NewGoal } from '#lib/daily-goals.js';
	import {
		archiveGoal,
		createGoal,
		getGoalDay,
		getGoalHistory,
		getGoals,
		reorderGoals,
		setSchedule,
		updateGoal
	} from '#lib/remote/goals.remote.js';
	import type { GoalSettings } from '#lib/server/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import AddGoalForm from './AddGoalForm.svelte';
	import GoalSettingsRow from './GoalSettingsRow.svelte';
	import GoalSetupForm from './GoalSetupForm.svelte';
	import WeekdayPicker from './WeekdayPicker.svelte';

	let { settings, open = $bindable(false) }: { settings: GoalSettings; open?: boolean } = $props();

	let pending = $state(false);

	/** Runs one or more writes, refreshing every goal view on the page; false when it failed. */
	async function run(work: () => Promise<unknown>): Promise<boolean> {
		pending = true;
		try {
			await work();
			return true;
		} catch {
			toast.error(m.goals_action_error());
			return false;
		} finally {
			pending = false;
		}
	}

	const views = [getGoalDay, getGoalHistory, getGoals] as const;

	function move(index: number, offset: -1 | 1) {
		const ids = settings.goals.map((goal) => goal.id);
		[ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
		void run(() => reorderGoals(ids).updates(...views));
	}

	function setUp(goals: NewGoal[], weekdays: number) {
		void run(async () => {
			await setSchedule(weekdays).updates(...views);
			for (const goal of goals) await createGoal(goal).updates(...views);
		}).then((saved) => {
			if (saved) open = false;
		});
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full gap-0 overflow-y-auto bg-day sm:max-w-md">
		<Sheet.Header class="border-b border-rule">
			<Sheet.Title>{m.goals_manage()}</Sheet.Title>
			<Sheet.Description>{m.goals_manage_desc()}</Sheet.Description>
		</Sheet.Header>
		<div class="flex flex-col gap-10 p-4">
			{#if settings.goals.length === 0}
				<GoalSetupForm {pending} onsave={setUp} />
			{:else}
				<section class="flex flex-col gap-2" aria-labelledby="goal-days-title">
					<h3 id="goal-days-title" class="text-lg">{m.goals_days_label()}</h3>
					<WeekdayPicker
						value={settings.weekdays ?? 0}
						label={m.goals_days_label()}
						disabled={pending}
						onchange={(mask) => void run(() => setSchedule(mask).updates(...views))}
					/>
					<p class="text-xs text-ink-3">{m.goals_days_hint()}</p>
				</section>

				<section class="flex flex-col gap-2" aria-labelledby="goal-list-title">
					<h3 id="goal-list-title" class="text-lg">{m.goals_list_title()}</h3>
					<ul class="flex flex-col gap-3">
						{#each settings.goals as goal, index (goal.id)}
							<GoalSettingsRow
								{goal}
								{pending}
								first={index === 0}
								last={index === settings.goals.length - 1}
								onsave={(changes) =>
									void run(() => updateGoal({ goalId: goal.id, ...changes }).updates(...views))}
								onmove={(offset) => move(index, offset)}
								onarchive={() => void run(() => archiveGoal(goal.id).updates(...views))}
							/>
						{/each}
					</ul>
				</section>

				<section class="flex flex-col gap-3" aria-labelledby="goal-add-title">
					<h3 id="goal-add-title" class="text-lg">{m.goals_add_goal()}</h3>
					<AddGoalForm {pending} onadd={(goal) => run(() => createGoal(goal).updates(...views))} />
				</section>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
```

- [ ] **Step 6: Wire the sheet into the page**

In `src/routes/dashboard/today/[[day]]/+page.svelte`, restore `import ManageGoalsSheet from '#lib/components/goals/ManageGoalsSheet.svelte';` and this block at the end of the markup (both are in the Task 6 listing):

```svelte
{#if settings !== undefined}
	<ManageGoalsSheet {settings} bind:open={manageOpen} />
{/if}
```

- [ ] **Step 7: Autofix, type-check, lint and commit**

Run `svelte-autofixer` on each new file until it is clean, then `bun run check && bun run lint` (expect 0 errors).

```bash
bunx prettier --write src/lib/components/goals/ "src/routes/dashboard/today/"
git add src/lib/components/goals/ "src/routes/dashboard/today/"
git commit -m "feat: manage daily goals and weekdays from a sheet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Overview card

**Files:**
- Create: `src/lib/components/goals/TodayGoalsCard.svelte`
- Modify: `src/routes/dashboard/+page.svelte` (imports; the title block, currently `<div class="pt-7"><h1 …>{m.dashboard_title()}</h1></div>`)

**Interfaces:**
- Consumes: Task 4 (`getGoalDay`, `getGoalHistory`); Task 5 messages.
- Produces: `<TodayGoalsCard />` with no props.

- [ ] **Step 1: Create the card**

Create `src/lib/components/goals/TodayGoalsCard.svelte` (it passed `svelte-autofixer`):

```svelte
<script lang="ts">
	import { resolve } from '$app/paths';
	import { getGoalDay, getGoalHistory } from '#lib/remote/goals.remote.js';
	import { formatNumber } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';

	// Created only once the page knows the time zone cookie is set (see the overview page).
	const dayQuery = getGoalDay(null);
	const historyQuery = getGoalHistory();

	const goalDay = $derived(dayQuery.current);
	const history = $derived(historyQuery.current);
	const done = $derived(goalDay?.goals.filter((goal) => goal.met).length ?? 0);
</script>

{#if goalDay !== undefined && history !== undefined}
	<a
		href={resolve('/dashboard/today')}
		class="group flex flex-wrap items-baseline gap-x-5 gap-y-1 border-y border-rule py-3 text-sm text-ink-2 hover:text-foreground"
	>
		<span class="text-base font-medium text-foreground">{m.goals_card_title()}</span>
		{#if goalDay.goals.length === 0}
			<span>{m.goals_card_setup()}</span>
		{:else}
			<span class="tabular-nums">
				{m.goals_card_done({ done: formatNumber(done), total: formatNumber(goalDay.goals.length) })}
			</span>
			<span class="tabular-nums">
				{m.goals_streak_short({ count: formatNumber(history.currentStreak) })}
			</span>
		{/if}
		<ArrowRightIcon
			class="ml-auto size-4 self-center transition-transform duration-(--dur-micro) group-hover:translate-x-0.5"
			aria-hidden="true"
		/>
	</a>
{/if}
```

- [ ] **Step 2: Place it on the Overview**

In `src/routes/dashboard/+page.svelte`, add `import TodayGoalsCard from '#lib/components/goals/TodayGoalsCard.svelte';` after the `WorkoutSheet` import, and replace the title block with:

```svelte
<div class="pt-7">
	<h1 class="text-4xl">{m.dashboard_title()}</h1>
	{#if page.data.timeZoneKnown || browser}
		<div class="mt-5">
			<TodayGoalsCard />
		</div>
	{/if}
</div>
```

`browser` and `page` are already imported in that file. The card sits above the period bar, so it shows even when there's no sleep or training data yet.

- [ ] **Step 3: Type-check, lint and commit**

Run: `bun run check && bun run lint`
Expected: 0 errors.

```bash
bunx prettier --write src/lib/components/goals/TodayGoalsCard.svelte src/routes/dashboard/+page.svelte
git add src/lib/components/goals/TodayGoalsCard.svelte src/routes/dashboard/+page.svelte
git commit -m "feat: show today's goals on the overview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Full verification on the disposable stack

**Files:** none, unless a defect turns up. Fix it in the file it lives in and commit with `fix: …`.

- [ ] **Step 1: Run the whole suite**

Run: `bun run check && bun run lint && bun run test:unit --run`
Expected: every check passes, including the existing tests.

- [ ] **Step 2: Start the test stack**

Run: `docker compose -f compose.test.yaml up -d --build`
Expected: the app answers at http://127.0.0.1:3300 and the startup log applies migration `0003_daily_goals`. Never start the `homefit` project, use `compose.dev.yaml`, or read `.env`.

- [ ] **Step 3: Check the feature in a browser**

Sign up with a new throwaway account (for example `goals-test@example.com`) and check each point:

1. The nav shows **Today** after Overview; ⌘K lists it.
2. With no goals, `/dashboard/today` shows the empty state. **Set up your daily goals** opens the sheet with Walking pad 60, Push-ups 100 and Plank 120, and Mon–Fri selected. Edit one target, remove Plank and save. The sheet closes and both cards appear.
3. Tap **+10 min** three times and add a custom 30 on Walking pad. The bar reads `60 / 60 min` and shows a check mark. Undo removes the 30.
4. Meet every goal. The status badge changes to **Done**, today's history cell fills, and the current streak becomes 1 on a scheduled day (on an unscheduled day the badge reads **Rest day** and the streak stays 0).
5. Go to the previous day with ‹ and log there. The URL becomes `/dashboard/today/YYYY-MM-DD`, › leads back, and the next button is disabled on today. Visiting a future date shows the error state with **Back to today**.
6. In **Manage goals**, rename a goal, change a target, reorder, and archive one after confirming. Today updates without a reload.
7. Untoggling every weekday is impossible; the last one stays selected.
8. The Overview shows the **Today's goals** strip with `n / m done` and the streak, linking to Today.
9. Switch the language to Español; the goal screens are translated.
10. At 375 px width, nothing scrolls horizontally on Today or in the sheet.

- [ ] **Step 4: Tear down**

Run: `docker compose -f compose.test.yaml down -v`
Expected: only the test stack and its volume are removed.

- [ ] **Step 5: Final commit (only if Step 3 required fixes)**

```bash
git status
git add <the files you fixed>
git commit -m "fix: <what was wrong>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
