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

	let {
		day
	}: {
		/** The day to show, `YYYY-MM-DD`; null shows today. */
		day: string | null;
	} = $props();

	// Without the time zone cookie the server would date "today" in UTC; wait for the browser to
	// set it, as the overview does.
	const ready = $derived(page.data.timeZoneKnown || browser);
	const dayQuery = $derived(ready ? getGoalDay(day) : null);
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

	/** Today's page has no day segment; every other day does. */
	function dayHref(target?: string) {
		return target === undefined
			? resolve('/dashboard/today')
			: resolve('/dashboard/today/[day]', { day: target });
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

	function add(goalId: string, entryDay: string, amount: number) {
		void write(goalId, () =>
			addEntry({ goalId, day: entryDay, amount }).updates(getGoalDay, getGoalHistory)
		);
	}

	function undo(goalId: string, entryDay: string) {
		void write(goalId, () =>
			undoLastEntry({ goalId, day: entryDay }).updates(getGoalDay, getGoalHistory)
		);
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
			<a href={dayHref()} class={buttonVariants({ variant: 'outline' })}>
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
					href={dayHref(previous)}
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
						href={dayHref(next === goalDay.today ? undefined : next)}
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
					<a href={dayHref()} class="underline underline-offset-2">
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
