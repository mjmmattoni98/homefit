<script lang="ts">
	import { resolve } from '$app/paths';
	import { SvelteMap } from 'svelte/reactivity';
	import { getDashboard } from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import StatCard from '#lib/components/dashboard/StatCard.svelte';
	import SleepQualityChart from '#lib/components/dashboard/SleepQualityChart.svelte';
	import SleepDurationChart from '#lib/components/dashboard/SleepDurationChart.svelte';
	import VolumeChart from '#lib/components/dashboard/VolumeChart.svelte';
	import WorkoutSheet from '#lib/components/dashboard/WorkoutSheet.svelte';
	import { formatDate, formatDateLong, formatHours, formatNumber } from '#lib/format.js';
	import { breakGaps, volumeByPeriod } from '#lib/charts.js';
	import { dayFromNumber, dayNumber, monthNumber, weekStart } from '#lib/days.js';
	import { compareMeans, mean, relativeChange } from '#lib/stats.js';
	import { browserTimeZone, rememberTimeZone } from '#lib/time-zone.js';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import BedDoubleIcon from '@lucide/svelte/icons/bed-double';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	// Periods the trend charts can show, in days; 'all' shows every record.
	const RANGES = ['30', '90', '365', 'all'] as const;
	// Longer spans chart monthly instead of weekly volume.
	const MAX_WEEKLY_BARS = 104;
	// Training and rest nights are only compared once each has this many nights.
	const MIN_COMPARED_NIGHTS = 10;

	const dashboardQuery = getDashboard();

	const dashboard = $derived(dashboardQuery.current);
	const nights = $derived(dashboard?.nights ?? []);
	const trainingDays = $derived(dashboard?.trainingDays ?? []);
	const hasError = $derived(dashboardQuery.error !== undefined);
	const isLoading = $derived(!hasError && !dashboardQuery.ready);
	const hasData = $derived(nights.length > 0 || trainingDays.length > 0);
	const workoutCount = $derived(trainingDays.reduce((sum, day) => sum + day.workouts, 0));

	// The server dates days in the time zone from a cookie. On the first visit (or after
	// travelling) it is told the browser's time zone and asked again, once per page.
	let timeZoneChecked = false;
	$effect(() => {
		if (dashboard === undefined || timeZoneChecked) return;
		timeZoneChecked = true;
		const timeZone = browserTimeZone();
		if (dashboard.timeZone !== timeZone) {
			rememberTimeZone(timeZone);
			void dashboardQuery.refresh();
		}
	});

	const todayNumber = $derived(dashboard === undefined ? 0 : dayNumber(dashboard.today));
	/** Days from `day` to today; 0 is today. */
	const daysAgo = (day: string) => todayNumber - dayNumber(day);

	let range = $state<(typeof RANGES)[number]>('90');

	// Exclude naps / incomplete nights from statistics
	const mainSleeps = $derived(nights.filter((r) => r.timeAsleepSeconds >= 3 * 3600));
	const rangeSleeps = $derived(
		range === 'all' ? mainSleeps : mainSleeps.filter((r) => daysAgo(r.night) < Number(range))
	);

	// Each figure covers the latest period and is compared with the one before it.
	const stats = $derived.by(() => {
		const between = (day: string, from: number, to: number) => {
			const ago = daysAgo(day);
			return ago >= from && ago < to;
		};
		const sleepIn = (from: number, to: number) =>
			mainSleeps.filter((r) => between(r.night, from, to));
		const trainingIn = (from: number, to: number, key: 'workouts' | 'volume') =>
			trainingDays
				.filter((day) => between(day.day, from, to))
				.reduce((sum, day) => sum + day[key], 0);
		const recent = sleepIn(0, 30);
		const before = sleepIn(30, 60);
		const quality = mean(recent.map((r) => r.sleepQuality));
		const asleep = mean(recent.map((r) => r.timeAsleepSeconds));
		const workouts = trainingIn(0, 7, 'workouts');
		const volume = trainingIn(0, 30, 'volume');
		return {
			quality,
			qualityChange: relativeChange(quality, mean(before.map((r) => r.sleepQuality))),
			asleep,
			asleepChange: relativeChange(asleep, mean(before.map((r) => r.timeAsleepSeconds))),
			nights: recent.length,
			workouts,
			workoutsChange: relativeChange(workouts, trainingIn(7, 14, 'workouts')),
			volume,
			volumeChange: relativeChange(volume, trainingIn(30, 60, 'volume'))
		};
	});

	const qualityData = $derived(
		breakGaps(
			rangeSleeps.map((r) => ({ date: new Date(r.wokeUp), quality: Math.round(r.sleepQuality) }))
		)
	);
	const durationData = $derived(
		breakGaps(
			rangeSleeps.map((r) => ({
				date: new Date(r.wokeUp),
				inBed: Math.round((r.timeInBedSeconds / 3600) * 10) / 10,
				asleep: Math.round((r.timeAsleepSeconds / 3600) * 10) / 10
			}))
		)
	);

	const volume = $derived.by(() => {
		const today = dashboard?.today;
		const oldest = trainingDays[0]?.day;
		if (today === undefined || oldest === undefined) return null;
		const from = range === 'all' ? oldest : dayFromNumber(dayNumber(today) - Number(range) + 1);
		const weeks = (dayNumber(weekStart(today)) - dayNumber(weekStart(from))) / 7 + 1;
		if (weeks <= MAX_WEEKLY_BARS) {
			return { monthly: false, data: volumeByPeriod(trainingDays, 'week', weeks, today) };
		}
		const months = monthNumber(today) - monthNumber(from) + 1;
		return { monthly: true, data: volumeByPeriod(trainingDays, 'month', months, today) };
	});

	const correlations = $derived.by(() => {
		const trained = new Set(trainingDays.map((day) => day.day));
		const training: number[] = [];
		const rest: number[] = [];
		for (const r of mainSleeps) {
			if (trained.has(r.night)) training.push(r.sleepQuality);
			else rest.push(r.sleepQuality);
		}
		return {
			trainingAvg: mean(training),
			trainingNights: training.length,
			restAvg: mean(rest),
			restNights: rest.length,
			comparison: compareMeans(training, rest, MIN_COMPARED_NIGHTS)
		};
	});

	// Nights with each note against nights without it.
	const notesImpact = $derived.by(() => {
		const byNote = new SvelteMap<string, number[]>();
		for (const r of mainSleeps) {
			for (const note of r.notes) {
				const list = byNote.get(note);
				if (list) list.push(r.sleepQuality);
				else byNote.set(note, [r.sleepQuality]);
			}
		}
		return [...byNote.entries()]
			.filter(([, qualities]) => qualities.length >= 2)
			.sort((a, b) => b[1].length - a[1].length)
			.slice(0, 10)
			.map(([note, withNote]) => {
				const without = mainSleeps
					.filter((r) => !r.notes.includes(note))
					.map((r) => r.sleepQuality);
				const comparison = compareMeans(withNote, without);
				return {
					note,
					nights: withNote.length,
					avg: mean(withNote) ?? 0,
					delta: comparison?.difference ?? null,
					clear: comparison?.clear ?? false
				};
			});
	});

	let workoutSheetOpen = $state(false);
	let selectedWorkout = $state<string | null>(null);

	function showWorkout(workoutId: string): void {
		selectedWorkout = workoutId;
		workoutSheetOpen = true;
	}
</script>

<svelte:head>
	<title>{m.dashboard_title()} · {m.app_name()}</title>
</svelte:head>

{#snippet noDataInRange()}
	<div
		class="flex h-[260px] items-center justify-center border border-dashed p-6 text-center text-sm text-muted-foreground"
	>
		{m.no_data_in_range()}
	</div>
{/snippet}

<div class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.dashboard_title()}</h1>

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-28 w-full" />
			{/each}
		</div>
		<div class="grid gap-4 lg:grid-cols-2">
			<Skeleton class="h-80 w-full" />
			<Skeleton class="h-80 w-full" />
		</div>
	{:else if hasError}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<DatabaseIcon />
				</Empty.Media>
				<Empty.Title>{m.data_error_title()}</Empty.Title>
				<Empty.Description>{m.data_error_description()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if !hasData}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<DatabaseIcon />
				</Empty.Media>
				<Empty.Title>{m.empty_title()}</Empty.Title>
				<Empty.Description>{m.empty_desc()}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<a href={resolve('/dashboard/import')} class={buttonVariants()}>{m.empty_cta()}</a>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<StatCard
				title={m.stat_avg_quality()}
				value={stats.quality != null ? `${Math.round(stats.quality)}%` : '—'}
				subtitle="{m.last_30_days()} · {m.nights_count({ count: stats.nights })}"
				icon={MoonIcon}
				change={stats.qualityChange}
				changeLabel={m.vs_previous_days({ days: 30 })}
			/>
			<StatCard
				title={m.stat_avg_asleep()}
				value={stats.asleep != null ? formatHours(stats.asleep) : '—'}
				subtitle={m.last_30_days()}
				icon={BedDoubleIcon}
				change={stats.asleepChange}
				changeLabel={m.vs_previous_days({ days: 30 })}
			/>
			<StatCard
				title={m.stat_workouts_week()}
				value={String(stats.workouts)}
				subtitle={m.last_7_days()}
				icon={DumbbellIcon}
				change={stats.workoutsChange}
				changeLabel={m.vs_previous_days({ days: 7 })}
			/>
			<StatCard
				title={m.stat_volume()}
				value="{formatNumber(stats.volume)} kg"
				subtitle={m.last_30_days()}
				icon={TrendingUpIcon}
				change={stats.volumeChange}
				changeLabel={m.vs_previous_days({ days: 30 })}
			/>
		</div>

		<section aria-labelledby="trends-heading" class="flex flex-col gap-4">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 id="trends-heading" class="text-xl font-semibold tracking-tight">
					{m.trends_title()}
				</h2>
				<ToggleGroup.Root
					type="single"
					value={range}
					variant="outline"
					size="sm"
					aria-label={m.range_label()}
				>
					{#each RANGES as option (option)}
						<ToggleGroup.Item
							value={option}
							aria-label={option === 'all' ? m.range_all() : m.range_days({ days: option })}
							onclick={() => (range = option)}
						>
							{option === 'all' ? m.range_all() : option}
						</ToggleGroup.Item>
					{/each}
				</ToggleGroup.Root>
			</div>

			{#if mainSleeps.length > 0}
				<div class="grid gap-4 lg:grid-cols-2">
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.sleep_quality_trend()}</Card.Title>
							<Card.Description>{m.sleep_quality_desc()}</Card.Description>
						</Card.Header>
						<Card.Content>
							{#if rangeSleeps.length > 1}
								<SleepQualityChart data={qualityData} />
							{:else}
								{@render noDataInRange()}
							{/if}
						</Card.Content>
					</Card.Root>
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.sleep_duration()}</Card.Title>
							<Card.Description>{m.sleep_duration_desc()}</Card.Description>
						</Card.Header>
						<Card.Content>
							{#if rangeSleeps.length > 1}
								<SleepDurationChart data={durationData} />
							{:else}
								{@render noDataInRange()}
							{/if}
						</Card.Content>
					</Card.Root>
				</div>
			{/if}

			{#if volume !== null}
				<div class="grid gap-4 lg:grid-cols-2">
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.volume_trend()}</Card.Title>
							<Card.Description>
								{volume.monthly ? m.volume_trend_desc_month() : m.volume_trend_desc()}
							</Card.Description>
						</Card.Header>
						<Card.Content>
							{#if volume.data.some((period) => period.volume > 0)}
								<VolumeChart
									data={volume.data}
									tooltipLabel={volume.monthly
										? (date) => formatDate(date.getTime(), { month: 'long', year: 'numeric' })
										: (date) => m.week_of({ date: formatDateLong(date.getTime()) })}
								/>
							{:else}
								{@render noDataInRange()}
							{/if}
						</Card.Content>
					</Card.Root>
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.recent_workouts()}</Card.Title>
							<Card.Description>{m.workouts_count({ count: workoutCount })}</Card.Description>
						</Card.Header>
						<Card.Content>
							<ul class="divide-y">
								{#each dashboard?.recentWorkouts ?? [] as workout (workout.id)}
									<li>
										<button
											type="button"
											aria-haspopup="dialog"
											class="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-2 px-2 py-2.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
											onclick={() => showWorkout(workout.id)}
										>
											<span class="min-w-0">
												<span class="block truncate text-sm font-medium">{workout.title}</span>
												<span class="block text-xs text-muted-foreground">
													{formatDate(workout.startTime)} · {workout.setsCount}
													{m.sets().toLowerCase()}
												</span>
											</span>
											<span class="flex shrink-0 items-center gap-1">
												<Badge variant="secondary">{formatNumber(workout.volume)} kg</Badge>
												<ChevronRightIcon class="size-4 text-muted-foreground" aria-hidden="true" />
											</span>
										</button>
									</li>
								{/each}
							</ul>
						</Card.Content>
					</Card.Root>
				</div>
			{/if}
		</section>

		{#if mainSleeps.length > 0}
			<section class="flex flex-col gap-4">
				<div>
					<h2 class="text-xl font-semibold tracking-tight">{m.correlations_title()}</h2>
					<p class="text-sm text-muted-foreground">{m.correlations_desc()}</p>
				</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<StatCard
						title={m.training_day()}
						value={correlations.trainingAvg != null
							? `${Math.round(correlations.trainingAvg)}%`
							: '—'}
						subtitle={m.nights_count({ count: correlations.trainingNights })}
						icon={DumbbellIcon}
					/>
					<StatCard
						title={m.rest_day()}
						value={correlations.restAvg != null ? `${Math.round(correlations.restAvg)}%` : '—'}
						subtitle={m.nights_count({ count: correlations.restNights })}
						icon={MoonIcon}
					/>
				</div>
				{#if correlations.comparison === null}
					<p class="text-sm text-muted-foreground">
						{m.correlation_not_enough({ nights: MIN_COMPARED_NIGHTS })}
					</p>
				{:else if !correlations.comparison.clear}
					<p class="text-sm text-muted-foreground">{m.correlation_no_difference()}</p>
				{:else}
					{@const points = formatNumber(Math.abs(correlations.comparison.difference), 1)}
					<p class="text-sm font-medium">
						{correlations.comparison.difference > 0
							? m.correlation_higher({ points })
							: m.correlation_lower({ points })}
					</p>
				{/if}

				{#if notesImpact.length > 0}
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.notes_impact_title()}</Card.Title>
							<Card.Description>{m.notes_impact_desc()}</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-3">
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.note()}</Table.Head>
										<Table.Head class="text-right">{m.nights()}</Table.Head>
										<!-- Headings may wrap so the table fits narrow screens. -->
										<Table.Head class="text-right whitespace-normal">{m.avg_quality()}</Table.Head>
										<Table.Head class="text-right whitespace-normal">
											{m.delta_vs_others()}
										</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each notesImpact as row (row.note)}
										<Table.Row>
											<Table.Cell class="font-medium">{row.note}</Table.Cell>
											<Table.Cell class="text-right">{row.nights}</Table.Cell>
											<Table.Cell class="text-right">{Math.round(row.avg)}%</Table.Cell>
											<Table.Cell
												class={!row.clear || row.delta === null
													? 'text-right text-muted-foreground'
													: row.delta > 0
														? 'text-right font-medium text-green-600 dark:text-green-400'
														: 'text-right font-medium text-red-600 dark:text-red-400'}
											>
												{#if row.delta === null}
													—
												{:else}
													{row.delta >= 0 ? '+' : '−'}{formatNumber(Math.abs(row.delta), 1)}
												{/if}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
							<p class="text-xs text-muted-foreground">{m.notes_impact_footnote()}</p>
						</Card.Content>
					</Card.Root>
				{/if}
			</section>
		{/if}
	{/if}
</div>

<WorkoutSheet workoutId={selectedWorkout} bind:open={workoutSheetOpen} />
