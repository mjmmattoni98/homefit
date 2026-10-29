<script lang="ts">
	import { browser } from '$app/env';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getDashboard } from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import CircadianSleepChart from '#lib/components/dashboard/CircadianSleepChart.svelte';
	import KpiStrip from '#lib/components/dashboard/KpiStrip.svelte';
	import SleepFactors from '#lib/components/dashboard/SleepFactors.svelte';
	import SleepSourcesChart from '#lib/components/dashboard/SleepSourcesChart.svelte';
	import SleepTrainingChart from '#lib/components/dashboard/SleepTrainingChart.svelte';
	import TrainingReadiness from '#lib/components/dashboard/TrainingReadiness.svelte';
	import WorkoutNights from '#lib/components/dashboard/WorkoutNights.svelte';
	import WorkoutSheet from '#lib/components/dashboard/WorkoutSheet.svelte';
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
		sleepReadiness,
		summarizeCircadian,
		summarizePeriod,
		summarizeVitals,
		workoutNights,
		workoutTimingImpact,
		type Period,
		type SleepFactorTarget
	} from '#lib/overview.js';
	import { compareSleepSources } from '#lib/sleep-sources.js';
	import { browserTimeZone, rememberTimeZone } from '#lib/time-zone.js';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	// Comparing nights with and without a factor needs a fair number of them; shorter periods use
	// every night instead.
	const MIN_FACTOR_NIGHTS = 60;

	// Without a time zone cookie the server would date every night in UTC, then the browser would
	// download the whole history a second time. Wait for the cookie the document sets first.
	const dashboardQuery = $derived(page.data.timeZoneKnown || browser ? getDashboard() : null);

	const dashboard = $derived(dashboardQuery?.current);
	const hasError = $derived(dashboardQuery?.error !== undefined);
	const isLoading = $derived(
		dashboardQuery === null || (dashboardQuery.error === undefined && !dashboardQuery.ready)
	);
	const hasData = $derived(
		(dashboard?.nights.length ?? 0) > 0 ||
			(dashboard?.googleSleepNights.length ?? 0) > 0 ||
			(dashboard?.trainingDays.length ?? 0) > 0
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
			void dashboardQuery?.refresh();
		}
	});

	let period = $state<Period>(30);
	let factorTarget = $state<SleepFactorTarget>('quality');

	const records = $derived(recordsByDay(dashboard?.nights ?? [], dashboard?.trainingDays ?? []));
	const summary = $derived(dashboard && summarizePeriod(records, dashboard.today, period));
	const granularity = $derived(summary ? chartGranularity(summary.from, summary.to) : 'day');
	const points = $derived(
		summary ? chartPoints(records, summary.from, summary.to, granularity) : []
	);

	const sleepComparison = $derived(
		dashboard && summary
			? compareSleepSources(
					dashboard.nights,
					dashboard.googleSleepNights,
					dashboard.timeZone,
					summary.from,
					summary.to
				)
			: null
	);
	const showSleepSources = $derived(
		(dashboard?.googleSleepNights.length ?? 0) > 0 &&
			(dashboard?.nights.length ?? 0) > 0 &&
			sleepComparison !== null
	);

	const circadian = $derived(
		dashboard && summary && summary.nights.length >= 2
			? summarizeCircadian(summary.nights, dashboard.timeZone)
			: null
	);

	const readiness = $derived(sleepReadiness(records));
	const timingBuckets = $derived(workoutTimingImpact(records));
	const vitals = $derived(
		dashboard && summary ? summarizeVitals(dashboard.vitalsDays, summary.from, summary.to) : null
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
		sleepFactors(factorsFromPeriod && summary ? summary.nights : allNights, records, factorTarget)
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
	<title>{m.dashboard_title()}: {m.app_name()}</title>
</svelte:head>

<div class="pt-7">
	<h1 class="text-4xl">{m.dashboard_title()}</h1>
</div>

<!-- One period drives every figure below, so its tabs and dates stay in view while scrolling. -->
<div class="sticky top-(--bar-height) z-20 bleed bg-day">
	<div
		class="flex flex-col-reverse gap-x-6 gap-y-1 border-b border-rule pt-2 sm:flex-row sm:items-end sm:justify-between"
	>
		<p class="min-w-0 truncate pb-2 text-sm text-ink-3 sm:pb-2.5">{caption}</p>
		<ToggleGroup.Root
			type="single"
			value={String(period)}
			variant="outline"
			aria-label={m.period_label()}
			class="w-full data-[variant=outline]:shadow-none sm:w-auto"
		>
			{#each PERIODS as option (option)}
				<ToggleGroup.Item
					value={String(option)}
					aria-label={periodName(option)}
					class="h-10 flex-1 px-3 text-[0.9375rem] sm:flex-none"
					onclick={() => (period = option)}
				>
					{periodLabel(option)}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</div>
</div>

{#if isLoading}
	<!-- The horizon's shape while the records load: the day above, the night below. -->
	<div class="bleed" aria-busy="true">
		<div class="flex gap-14 pt-10 pb-8">
			<Skeleton class="h-20 w-40" />
			<Skeleton class="h-20 w-56" />
		</div>
		<div class="bleed h-80 bg-night"></div>
	</div>
{:else if hasError}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.data_error_title()}</Empty.Title>
			<Empty.Description>{m.data_error_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if !hasData || summary === undefined}
	<Empty.Root class="mt-10 border border-rule">
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
	<!-- The horizon: the period's training above the line, its nights below it. -->
	<section class="bleed" aria-labelledby="sleep-training-title">
		<div class="flex flex-col gap-8 pt-9 pb-7 lg:flex-row lg:items-end lg:justify-between">
			<div class="min-w-0 lg:max-w-[22rem]">
				<h2 id="sleep-training-title" class="text-2xl">{m.chart_title()}</h2>
				<p class="mt-2 text-sm text-ink-3">{m.chart_hint()}</p>
			</div>
			<KpiStrip side="day" {summary} {points} {comparedWith} />
		</div>
		<p class="flex items-center gap-2 pb-3 text-sm text-ink-2">
			<span class="size-2.5 bg-sun" aria-hidden="true"></span>
			{m.chart_volume()}
		</p>
		{#if points.some((point) => point.quality !== null || point.volume > 0)}
			<SleepTrainingChart {points} {granularity} average={summary.quality} />
		{:else}
			<div class="bleed">
				<div class="flex h-40 items-end pb-3 text-sm text-ink-3">{m.no_data_in_range()}</div>
				<div class="bleed h-44 bg-night"></div>
			</div>
		{/if}
		<div class="bleed bg-night text-moon">
			<div class="flex flex-col gap-8 pt-4 pb-12">
				<ul class="flex flex-wrap gap-x-6 gap-y-2 text-sm text-moon-2">
					<li class="flex items-center gap-2">
						<span class="size-2.5 bg-sleep" aria-hidden="true"></span>
						{qualityLegend}
					</li>
					<li class="flex items-center gap-2">
						<span class="h-[3px] w-4 bg-moon" aria-hidden="true"></span>
						{trendLegend}
					</li>
					<li class="flex items-center gap-2">
						<span class="h-px w-4 bg-moon" aria-hidden="true"></span>
						{m.chart_period_average()}
					</li>
				</ul>
				<KpiStrip side="night" {summary} {points} {comparedWith} />
			</div>

			{#if showSleepSources && sleepComparison !== null}
				<SleepSourcesChart comparison={sleepComparison} embedded />
			{/if}

			{#if circadian !== null}
				<CircadianSleepChart {circadian} />
			{/if}
		</div>
	</section>

	<div class="mt-16">
		<TrainingReadiness {readiness} timing={timingBuckets} {vitals} />
	</div>

	<div class="mt-16 grid items-start gap-x-14 gap-y-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
		{#if workoutRows.length > 0}
			<WorkoutNights rows={workoutRows} onselect={showWorkout} />
		{/if}
		{#if allNights.length > 0}
			<SleepFactors
				{factors}
				description={factorsDescription}
				target={factorTarget}
				ontargetchange={(next) => (factorTarget = next)}
			/>
		{/if}
	</div>
{/if}

<WorkoutSheet workoutId={selectedWorkout} bind:open={workoutSheetOpen} />
