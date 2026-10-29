<script lang="ts">
	import { resolve } from '$app/paths';
	import { getCategories, getMetrics, getOverview } from '#lib/remote/health.remote.js';
	import { getDashboard } from '#lib/remote/imports.remote.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import SleepSourcesChart from '#lib/components/dashboard/SleepSourcesChart.svelte';
	import HealthCompareSection from '#lib/components/google-health/HealthCompareSection.svelte';
	import HealthMetricCard from '#lib/components/google-health/HealthMetricCard.svelte';
	import HealthSyncBanner from '#lib/components/google-health/HealthSyncBanner.svelte';
	import HealthTrendChart from '#lib/components/google-health/HealthTrendChart.svelte';
	import { dayFromNumber, dayNumber } from '#lib/days.js';
	import { formatDateLong } from '#lib/format.js';
	import { categoryLabel, metricLabel } from '#lib/google-health/labels.js';
	import { summaryNumber } from '#lib/google-health/view.js';
	import * as m from '#lib/paraglide/messages.js';
	import { compareSleepSources } from '#lib/sleep-sources.js';
	import { cn } from '#lib/utils.js';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const OVERVIEW_DAYS = 30;

	const overviewQuery = getOverview(OVERVIEW_DAYS);
	const categoriesQuery = getCategories();
	const activityQuery = getMetrics('activity');
	const dashboardQuery = getDashboard();

	const overview = $derived(overviewQuery.current);
	const categories = $derived(categoriesQuery.current ?? []);
	const dashboard = $derived(dashboardQuery.current);

	const sleepComparison = $derived.by(() => {
		if (!dashboard || dashboard.nights.length === 0 || dashboard.googleSleepNights.length === 0) {
			return null;
		}
		const from = dayFromNumber(dayNumber(dashboard.today) - OVERVIEW_DAYS + 1);
		return compareSleepSources(
			dashboard.nights,
			dashboard.googleSleepNights,
			dashboard.timeZone,
			from,
			dashboard.today
		);
	});
	const recentActivity = $derived(
		[...(activityQuery.current ?? [])]
			.sort(
				(left, right) =>
					(right.latestSummary.latestTimestamp ?? 0) - (left.latestSummary.latestTimestamp ?? 0)
			)
			.slice(0, 4)
	);
	const chartMetric = $derived(
		overview?.metrics.find((metric) =>
			metric.trend.some((summary) => summaryNumber(metric, summary) !== null)
		)
	);
	const hasError = $derived(
		overviewQuery.error !== undefined ||
			categoriesQuery.error !== undefined ||
			activityQuery.error !== undefined
	);
	const isLoading = $derived(
		!hasError && (!overviewQuery.ready || !categoriesQuery.ready || !activityQuery.ready)
	);

	// The day's measurements first; sleep hangs below them on the night field.
	const dayMetrics = $derived(overview?.metrics.filter((metric) => metric.category !== 'sleep'));
	const nightMetrics = $derived(overview?.metrics.filter((metric) => metric.category === 'sleep'));

	const TAB =
		'flex h-10 items-center px-3 text-[0.9375rem] font-medium whitespace-nowrap text-ink-3 transition-colors duration-(--dur-micro) hover:text-foreground focus-visible:-outline-offset-2';

	// The metric, its trend, the latest figure and the last change; on phones the trend and the
	// change drop to a second line under the metric and the figure.
	const LEDGER =
		'grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_auto_minmax(6.5rem,auto)] sm:gap-x-10';

	const recordedAt = (summary: { latestTimestamp: number | null; localDate: string }) =>
		formatDateLong(
			summary.latestTimestamp ?? new Date(`${summary.localDate}T00:00:00.000Z`).getTime()
		);
</script>

<svelte:head>
	<title>{m.health_overview_title()}: {m.app_name()}</title>
</svelte:head>

<div
	class="flex flex-col gap-4 border-b border-rule pt-7 pb-3 lg:flex-row lg:items-end lg:justify-between"
>
	<div class="min-w-0">
		<h1 class="text-4xl">{m.health_overview_title()}</h1>
		<p class="mt-1.5 text-sm text-ink-3">{m.health_overview_description()}</p>
	</div>
	<nav aria-label={m.nav_health()} class="-mx-4 min-w-0 overflow-x-auto px-4 md:mx-0 md:px-0">
		<ul class="flex w-max shadow-[inset_0_-1px_0_var(--color-rule)]">
			<li>
				<a
					href={resolve('/dashboard/health')}
					aria-current="page"
					class={cn(TAB, 'text-foreground shadow-[inset_0_-2px_0_var(--color-sun)]')}
				>
					{m.nav_overview()}
				</a>
			</li>
			{#each categories as item (item.category)}
				<li>
					<a
						href={resolve('/dashboard/health/[category]', { category: item.category })}
						class={TAB}
					>
						{categoryLabel(item.category)}
						<span class="ml-1.5 text-sm font-normal text-ink-3">{item.count}</span>
					</a>
				</li>
			{/each}
			<li>
				<a href={resolve('/dashboard/health/metrics')} class={TAB}>{m.nav_all_metrics()}</a>
			</li>
		</ul>
	</nav>
</div>

<HealthSyncBanner />

{#if isLoading}
	<div class="mt-10" aria-busy="true">
		<div class="border-t border-ink pt-10">
			{#each [0, 1, 2, 3] as index (index)}
				<div class="flex items-center gap-10 border-b border-rule py-4">
					<Skeleton class="h-10 w-48" />
					<Skeleton class="hidden h-8 flex-1 sm:block" />
					<Skeleton class="ml-auto h-10 w-32 sm:ml-0" />
				</div>
			{/each}
		</div>
		<Skeleton class="mt-16 h-72 w-full lg:w-7/12" />
	</div>
{:else if hasError}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_query_error_title()}</Empty.Title>
			<Empty.Description>{m.health_query_error_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if overview === undefined || overview.metrics.length === 0}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_no_data_title()}</Empty.Title>
			<Empty.Description>{m.health_no_data_description()}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a href={resolve('/dashboard/import')} class={buttonVariants()}>{m.health_no_data_cta()}</a>
		</Empty.Content>
	</Empty.Root>
{:else}
	<!-- The latest of each measurement as a ledger: one row per metric, its last 30 days drawn
	     across the middle. -->
	<div class={cn('mt-10 border-t border-ink', LEDGER)}>
		<div
			class="col-span-full grid grid-cols-subgrid py-2.5 text-sm text-ink-3 max-sm:hidden"
			aria-hidden="true"
		>
			<span></span>
			<span class="hidden sm:block">{m.period_last_days({ days: OVERVIEW_DAYS })}</span>
			<span class="text-right">{m.health_latest()}</span>
			<span class="hidden sm:block"></span>
		</div>
		{#if dayMetrics && dayMetrics.length > 0}
			<ul class="col-span-full grid grid-cols-subgrid">
				{#each dayMetrics as metric (metric.dataType)}
					<li class="col-span-full grid grid-cols-subgrid border-t border-rule">
						<HealthMetricCard {metric} trend={metric.trend} />
					</li>
				{/each}
			</ul>
		{/if}
		{#if nightMetrics && nightMetrics.length > 0}
			<!-- Below the day's rows, the nights: the panel reaches past the column so its rows keep
			     the ledger's columns. -->
			<ul
				class="col-span-full -mx-4 grid grid-cols-subgrid bg-night px-4 text-moon md:-mx-5 md:px-5"
				aria-label={categoryLabel('sleep')}
			>
				{#each nightMetrics as metric (metric.dataType)}
					<li
						class="col-span-full grid grid-cols-subgrid border-t border-night-rule first:border-t-0"
					>
						<HealthMetricCard {metric} trend={metric.trend} />
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="mt-16 grid items-start gap-x-14 gap-y-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
		{#if chartMetric !== undefined}
			{@const night = chartMetric.category === 'sleep'}
			<section
				class={cn('min-w-0', night && 'bg-night px-5 pt-6 pb-5 text-moon sm:px-7')}
				aria-labelledby="health-trend-title"
			>
				<h2 id="health-trend-title" class="text-2xl">
					{m.health_trend_title()}: {metricLabel(chartMetric.dataType)}
				</h2>
				<p class={cn('mt-2 text-sm', night ? 'text-moon-2' : 'text-ink-3')}>
					{m.health_trend_description({ metric: metricLabel(chartMetric.dataType) })}
				</p>
				<div class="mt-6">
					<HealthTrendChart metric={chartMetric} summaries={chartMetric.trend} />
				</div>
			</section>
		{/if}

		<section class="min-w-0" aria-labelledby="health-recent-title">
			<h2 id="health-recent-title" class="text-2xl">{m.health_recent_title()}</h2>
			<p class="mt-2 text-sm text-ink-3">{m.health_recent_description()}</p>
			{#if recentActivity.length === 0}
				<p class="mt-6 border-t border-ink pt-4 text-sm text-ink-3">{m.health_no_records()}</p>
			{:else}
				<div class="mt-6 grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-6 border-t border-ink">
					<div
						class="col-span-full grid grid-cols-subgrid py-2.5 text-sm text-ink-3 max-sm:hidden"
						aria-hidden="true"
					>
						<span></span>
						<span>{m.health_date()}</span>
						<span class="text-right">{m.health_count()}</span>
					</div>
					<ul class="col-span-full grid grid-cols-subgrid">
						{#each recentActivity as metric (metric.dataType)}
							<li class="col-span-full grid grid-cols-subgrid border-t border-rule">
								<a
									href={resolve('/dashboard/health/metrics/[dataType]', {
										dataType: metric.dataType
									})}
									class="group col-span-full grid grid-cols-subgrid items-baseline py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
								>
									<span
										class="min-w-0 truncate font-medium underline-offset-4 group-hover:underline group-hover:decoration-sun"
									>
										{metricLabel(metric.dataType)}
									</span>
									<span class="text-sm whitespace-nowrap text-ink-3">
										{recordedAt(metric.latestSummary)}
									</span>
									<span class="text-right">{metric.latestSummary.count}</span>
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	</div>

	{#if sleepComparison !== null}
		<div class="mt-16">
			<SleepSourcesChart comparison={sleepComparison} />
		</div>
	{/if}

	<HealthCompareSection metrics={overview.metrics} />
{/if}
