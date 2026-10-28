<script lang="ts">
	import { resolve } from '$app/paths';
	import { getDashboard } from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import KpiStrip from '#lib/components/dashboard/KpiStrip.svelte';
	import SleepFactors from '#lib/components/dashboard/SleepFactors.svelte';
	import SleepTrainingChart from '#lib/components/dashboard/SleepTrainingChart.svelte';
	import WorkoutNights from '#lib/components/dashboard/WorkoutNights.svelte';
	import WorkoutSheet from '#lib/components/dashboard/WorkoutSheet.svelte';
	import { CHART_COLORS } from '#lib/charts.js';
	import { dayToDate } from '#lib/days.js';
	import { formatDate } from '#lib/format.js';
	import {
		PERIODS,
		TREND_DAYS,
		chartGranularity,
		chartPoints,
		mainNights,
		recordsByDay,
		sleepFactors,
		summarizePeriod,
		workoutNights,
		type Period
	} from '#lib/overview.js';
	import { browserTimeZone, rememberTimeZone } from '#lib/time-zone.js';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	// Comparing nights with and without a factor needs a fair number of them; shorter periods use
	// every night instead.
	const MIN_FACTOR_NIGHTS = 60;

	const dashboardQuery = getDashboard();

	const dashboard = $derived(dashboardQuery.current);
	const hasError = $derived(dashboardQuery.error !== undefined);
	const isLoading = $derived(!hasError && !dashboardQuery.ready);
	const hasData = $derived(
		(dashboard?.nights.length ?? 0) > 0 || (dashboard?.trainingDays.length ?? 0) > 0
	);

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

	let period = $state<Period>(30);

	const records = $derived(recordsByDay(dashboard?.nights ?? [], dashboard?.trainingDays ?? []));
	const summary = $derived(dashboard && summarizePeriod(records, dashboard.today, period));
	const granularity = $derived(summary ? chartGranularity(summary.from, summary.to) : 'day');
	const points = $derived(
		summary ? chartPoints(records, summary.from, summary.to, granularity) : []
	);

	const comparedWith = $derived(period === 'all' ? '' : m.vs_previous_days({ days: period }));
	const caption = $derived.by(() => {
		if (summary === undefined) return '';
		const options: Intl.DateTimeFormatOptions =
			granularity === 'day'
				? { day: 'numeric', month: 'short' }
				: { day: 'numeric', month: 'short', year: 'numeric' };
		const from = formatDate(dayToDate(summary.from).getTime(), options);
		const to = formatDate(dayToDate(summary.to).getTime(), options);
		if (period === 'all') return m.period_caption_all({ from, to });
		return summary.comparable
			? m.period_caption_compared({ from, to, days: period })
			: m.period_caption_not_comparable({ from, to, days: period });
	});

	const allNights = $derived(mainNights(dashboard?.nights ?? []));
	const factorsFromPeriod = $derived((summary?.nights.length ?? 0) >= MIN_FACTOR_NIGHTS);
	const factors = $derived(
		sleepFactors(factorsFromPeriod && summary ? summary.nights : allNights, records)
	);
	const factorsDescription = $derived(
		factorsFromPeriod
			? m.factors_desc_period({ count: summary?.nights.length ?? 0 })
			: m.factors_desc_all({ count: allNights.length })
	);

	const workoutRows = $derived(
		dashboard ? workoutNights(dashboard.recentWorkouts, records, dashboard.timeZone) : []
	);

	const periodLabel = (option: Period) =>
		option === 'all'
			? m.range_all()
			: option === 365
				? m.period_short_year()
				: m.period_short_days({ days: option });
	const periodName = (option: Period) =>
		option === 'all'
			? m.period_all_records()
			: option === 365
				? m.period_last_year()
				: m.period_last_days({ days: option });

	const qualityLegend = $derived(
		{
			day: m.chart_quality_day(),
			week: m.chart_quality_week(),
			month: m.chart_quality_month()
		}[granularity]
	);
	const trendLegend = $derived(m.chart_trend({ days: TREND_DAYS[granularity] }));

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

<!-- One period drives every figure below, so it stays in view while scrolling. -->
<div
	class="sticky top-12 z-20 -mx-4 -mt-4 mb-4 flex flex-col gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur sm:flex-row sm:items-center sm:justify-between md:-mx-6 md:px-6"
>
	<div class="min-w-0">
		<h1 class="text-lg font-semibold tracking-tight">{m.dashboard_title()}</h1>
		<p class="truncate text-xs text-muted-foreground tabular-nums">{caption}</p>
	</div>
	<ToggleGroup.Root
		type="single"
		value={String(period)}
		variant="outline"
		size="sm"
		aria-label={m.period_label()}
		class="w-full sm:w-auto"
	>
		{#each PERIODS as option (option)}
			<ToggleGroup.Item
				value={String(option)}
				aria-label={periodName(option)}
				class="flex-1 px-3 tabular-nums sm:flex-none"
				onclick={() => (period = option)}
			>
				{periodLabel(option)}
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>
</div>

{#if isLoading}
	<div class="flex flex-col gap-4">
		<Skeleton class="h-36 w-full" />
		<Skeleton class="h-80 w-full" />
		<div class="grid gap-4 lg:grid-cols-2">
			<Skeleton class="h-72 w-full" />
			<Skeleton class="h-72 w-full" />
		</div>
	</div>
{:else if hasError}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.data_error_title()}</Empty.Title>
			<Empty.Description>{m.data_error_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if !hasData || summary === undefined}
	<Empty.Root class="border">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.empty_title()}</Empty.Title>
			<Empty.Description>{m.empty_desc()}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a href={resolve('/dashboard/import')} class={buttonVariants()}>{m.empty_cta()}</a>
		</Empty.Content>
	</Empty.Root>
{:else}
	<div class="flex flex-col gap-4">
		<KpiStrip {summary} {points} {comparedWith} />

		<section class="rounded-lg border bg-card p-4" aria-labelledby="sleep-training-title">
			<div class="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
				<div>
					<h2 id="sleep-training-title" class="font-semibold tracking-tight">
						{m.chart_title()}
					</h2>
					<p class="text-xs text-muted-foreground">{m.chart_hint()}</p>
				</div>
				<ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<li class="flex items-center gap-1.5">
						<span class="size-2 rounded-full opacity-50" style:background={CHART_COLORS.quality}
						></span>
						{qualityLegend}
					</li>
					<li class="flex items-center gap-1.5">
						<span class="h-0.5 w-4 rounded" style:background={CHART_COLORS.quality}></span>
						{trendLegend}
					</li>
					<li class="flex items-center gap-1.5">
						<span class="w-4 border-t border-dashed border-foreground/60"></span>
						{m.chart_period_average()}
					</li>
					<li class="flex items-center gap-1.5">
						<span class="size-2 rounded-sm" style:background={CHART_COLORS.volume}></span>
						{m.chart_volume()}
					</li>
				</ul>
			</div>
			{#if points.some((point) => point.quality !== null || point.volume > 0)}
				<SleepTrainingChart {points} {granularity} average={summary.quality} />
			{:else}
				<div
					class="flex h-[300px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground"
				>
					{m.no_data_in_range()}
				</div>
			{/if}
		</section>

		<div class="grid gap-4 lg:grid-cols-2">
			{#if allNights.length > 0}
				<SleepFactors {factors} description={factorsDescription} />
			{/if}
			{#if workoutRows.length > 0}
				<WorkoutNights rows={workoutRows} onselect={showWorkout} />
			{/if}
		</div>
	</div>
{/if}

<WorkoutSheet workoutId={selectedWorkout} bind:open={workoutSheetOpen} />
