<script lang="ts">
	import Measure from '#lib/components/Measure.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getMetricRecords, getMetricTrend, getMetrics } from '#lib/remote/health.remote.js';
	import type { RecordsCursor } from '#lib/server/google-health/records.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import HealthSyncBanner from '#lib/components/google-health/HealthSyncBanner.svelte';
	import HealthTrendChart from '#lib/components/google-health/HealthTrendChart.svelte';
	import { categoryLabel, metricLabel } from '#lib/google-health/labels.js';
	import {
		dateRange,
		formatDuration,
		formatMetricValue,
		formatSummaryValue,
		isHealthDataType,
		payloadPath,
		payloadValue
	} from '#lib/google-health/view.js';
	import { formatDateLong } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const RANGE_DAYS = [7, 30, 90, 365] as const;
	const RECORDS_PAGE_SIZE = 8;

	const dataType = $derived.by(() => {
		const value = page.params.dataType;
		return value !== undefined && isHealthDataType(value) ? value : null;
	});
	let rangeValue = $state('30');
	const rangeDays = $derived(Number(rangeValue));

	const metricsQuery = $derived(dataType === null ? null : getMetrics(null));
	const metric = $derived(metricsQuery?.current?.find((item) => item.dataType === dataType));
	const selectedRange = $derived(
		metric === undefined ? null : dateRange(metric.latestSummary.localDate, rangeDays)
	);
	const trendQuery = $derived(
		dataType === null || selectedRange === null
			? null
			: getMetricTrend({ dataType, ...selectedRange })
	);

	// One query per loaded page. Each starts where the previous page currently ends, so pages stay
	// contiguous when a refresh adds or removes earlier records. Navigating to another metric
	// resets the list to its first page.
	let pageCount = $derived(dataType === null ? 0 : 1);
	const recordPages = $derived.by(() => {
		if (dataType === null) return [];
		const records = (after: RecordsCursor | null) =>
			getMetricRecords({ dataType, limit: RECORDS_PAGE_SIZE, after });
		const pages = [records(null)];
		while (pages.length < pageCount) {
			const after = pages[pages.length - 1].current?.nextCursor ?? null;
			if (after === null) break;
			pages.push(records(after));
		}
		return pages;
	});
	const lastPage = $derived(recordPages.at(-1));
	const nextCursor = $derived(lastPage?.current?.nextCursor ?? null);
	const loadingMore = $derived(recordPages.length > 1 && lastPage !== undefined && !lastPage.ready);

	const trend = $derived(trendQuery?.current?.kind === 'found' ? trendQuery.current.summaries : []);
	const records = $derived(recordPages.flatMap((query) => query.current?.records ?? []));
	const hasError = $derived(
		metricsQuery?.error !== undefined ||
			trendQuery?.error !== undefined ||
			recordPages.some((query) => query.error !== undefined)
	);
	const isLoading = $derived(
		!hasError &&
			dataType !== null &&
			(metricsQuery?.ready !== true || recordPages[0]?.ready !== true)
	);

	function loadMore(): void {
		if (nextCursor !== null) pageCount = recordPages.length + 1;
	}

	function recordValue(primaryValue: number | null, primaryUnit: string | null): string {
		return primaryValue === null || dataType === null
			? m.health_recorded()
			: formatMetricValue(primaryValue, primaryUnit, dataType);
	}

	// The day the summary figures describe, besides the latest value.
	const summaryFigures = $derived.by(() => {
		if (metric === undefined) return [];
		const summary = metric.latestSummary;
		const format = (value: number) => formatMetricValue(value, metric.primaryUnit, metric.dataType);
		return [
			summary.average === null
				? null
				: { label: m.health_average(), value: format(summary.average) },
			summary.min === null ? null : { label: m.health_minimum(), value: format(summary.min) },
			summary.max === null ? null : { label: m.health_maximum(), value: format(summary.max) },
			metric.aggregation === 'sum' && summary.sum !== null
				? { label: m.health_total(), value: format(summary.sum) }
				: null,
			metric.aggregation === 'duration' && summary.durationSeconds !== null
				? { label: m.health_duration(), value: formatDuration(summary.durationSeconds) }
				: null,
			{ label: m.health_count(), value: String(summary.count) }
		].filter((figure) => figure !== null);
	});
	const lastRecorded = $derived(
		metric === undefined
			? null
			: (metric.latestSummary.latestTimestamp ??
					new Date(`${metric.latestSummary.localDate}T00:00:00.000Z`).getTime())
	);

	// Sleep is measured on the nights, so its trend is drawn on a night panel.
	const night = $derived(metric?.category === 'sleep');

	const rangeLabel = (days: number) =>
		days === 365 ? m.period_short_year() : m.period_short_days({ days });

	// The date stays pinned while the rest of a record scrolls sideways on a phone.
	const PINNED =
		'sticky left-0 z-10 bg-day pr-5 max-sm:shadow-[inset_-1px_0_0_var(--color-rule)] sm:pr-8';
</script>

<svelte:head>
	<title>
		{dataType === null ? m.health_not_found_title() : metricLabel(dataType)}: {m.app_name()}
	</title>
</svelte:head>

<div class="border-b border-rule pt-7 pb-3">
	<nav aria-label={m.nav_breadcrumb()} class="mb-2 text-sm text-ink-3">
		<ol class="flex flex-wrap items-center gap-x-2">
			<li>
				<a
					href={resolve('/dashboard/health')}
					class="underline-offset-4 transition-colors duration-(--dur-micro) hover:text-foreground hover:underline hover:decoration-sun"
				>
					{m.nav_health()}
				</a>
			</li>
			{#if metric !== undefined}
				<li class="flex items-center gap-x-2">
					<span class="text-rule-2" aria-hidden="true">/</span>
					<a
						href={resolve('/dashboard/health/[category]', { category: metric.category })}
						class="underline-offset-4 transition-colors duration-(--dur-micro) hover:text-foreground hover:underline hover:decoration-sun"
					>
						{categoryLabel(metric.category)}
					</a>
				</li>
			{/if}
		</ol>
	</nav>
	<h1 class="text-4xl">
		{metric === undefined
			? dataType === null
				? m.health_not_found_title()
				: metricLabel(dataType)
			: metricLabel(metric.dataType)}
	</h1>
	{#if metric !== undefined}
		<p class="mt-1.5 text-sm text-ink-3">{m.health_source()}: {metric.sourceLabel}</p>
	{/if}
</div>

<HealthSyncBanner />

{#if isLoading}
	<div aria-busy="true">
		<div class="flex flex-wrap items-end gap-x-14 gap-y-6 pt-9">
			<Skeleton class="h-20 w-56" />
			<Skeleton class="h-14 w-32" />
			<Skeleton class="h-14 w-32" />
		</div>
		<Skeleton class="mt-16 h-[300px] w-full" />
	</div>
{:else if hasError}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_query_error_title()}</Empty.Title>
			<Empty.Description>{m.health_query_error_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if dataType === null || metric === undefined}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_not_found_title()}</Empty.Title>
			<Empty.Description>{m.health_not_found_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<!-- The lead: the latest value, large, then the figures of the day it was recorded, without
	     boxes. -->
	<section aria-labelledby="health-summary-heading" class="pt-9">
		<h2 id="health-summary-heading" class="text-2xl">{m.health_stats_title()}</h2>
		<div class="mt-6 flex flex-col gap-x-14 gap-y-8 lg:flex-row lg:items-end">
			<dl class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-ink-3">{m.health_latest()}</dt>
				<dd>
					<Measure
						value={String(formatSummaryValue(metric, metric.latestSummary, m.health_recorded()))}
						class="text-5xl font-figure"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
					/>
				</dd>
				{#if lastRecorded !== null}
					<dd class="text-sm text-ink-3">
						{m.health_last_recorded({ date: formatDateLong(lastRecorded) })}
					</dd>
				{/if}
			</dl>
			<dl
				class="grid grid-cols-2 gap-x-8 gap-y-6 border-t border-rule pt-6 sm:flex sm:flex-wrap sm:gap-x-12 lg:border-t-0 lg:border-l lg:pt-0 lg:pb-6 lg:pl-14"
			>
				{#each summaryFigures as figure (figure.label)}
					<div class="flex min-w-0 flex-col gap-1">
						<dt class="text-sm text-ink-3">{figure.label}</dt>
						<dd>
							<Measure
								value={figure.value}
								class="text-2xl font-figure"
								unitClass="ml-[0.25em] text-sm font-medium text-ink-3"
							/>
						</dd>
					</div>
				{/each}
			</dl>
		</div>
	</section>

	<section
		aria-labelledby="health-trend-title"
		class={cn('mt-16', night && 'bg-night px-5 pt-6 pb-5 text-moon sm:px-7')}
	>
		<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
			<div class="min-w-0">
				<h2 id="health-trend-title" class="text-2xl">{m.health_trend_title()}</h2>
				<p class={cn('mt-2 text-sm', night ? 'text-moon-2' : 'text-ink-3')}>
					{m.health_trend_description({ metric: metricLabel(metric.dataType) })}
				</p>
			</div>
			<ToggleGroup.Root
				type="single"
				value={rangeValue}
				variant="outline"
				class={cn('w-full sm:w-auto', night && 'shadow-[inset_0_-1px_0_var(--color-night-rule)]')}
			>
				{#each RANGE_DAYS as days (days)}
					<ToggleGroup.Item
						value={String(days)}
						aria-label={m.health_range_days({ days })}
						class={cn(
							'h-10 flex-1 px-3 text-[0.9375rem] sm:flex-none',
							night && 'text-moon-2 hover:text-moon data-[state=on]:text-moon'
						)}
						onclick={() => (rangeValue = String(days))}
					>
						{rangeLabel(days)}
					</ToggleGroup.Item>
				{/each}
			</ToggleGroup.Root>
		</div>
		<div class="mt-6">
			{#if trendQuery !== null && !trendQuery.ready}
				<Skeleton class={cn('h-[278px] w-full', night && 'bg-night-2')} />
			{:else}
				<HealthTrendChart {metric} summaries={trend} />
			{/if}
		</div>
	</section>

	<!-- The records are a ledger: a heavy rule opens it, hairlines part the rows. -->
	<section class="mt-16 min-w-0" aria-labelledby="health-records-title">
		<h2 id="health-records-title" class="text-2xl">{m.health_records_title()}</h2>
		<p class="mt-2 text-sm text-ink-3">{m.health_records_description()}</p>
		{#if records.length === 0}
			<p class="mt-6 border-t border-ink pt-4 text-sm text-ink-3">{m.health_no_records()}</p>
		{:else}
			<div class="mt-6 overflow-x-auto">
				<table class="w-full border-t border-ink text-left">
					<thead class="text-sm text-ink-3">
						<tr>
							<th scope="col" class={cn(PINNED, 'py-2.5 font-normal')}>{m.health_date()}</th>
							<th scope="col" class="py-2.5 pr-8 text-right font-normal">{m.health_value()}</th>
							<th scope="col" class="py-2.5 pr-8 font-normal">{m.health_application()}</th>
							<th scope="col" class="py-2.5 pr-8 font-normal">{m.health_device()}</th>
							<th scope="col" class="py-2.5 pr-8 font-normal">{m.health_method()}</th>
							<th scope="col" class="py-2.5 font-normal">{m.health_details()}</th>
						</tr>
					</thead>
					<tbody>
						{#each records as record, index (index)}
							<tr class="border-t border-rule align-baseline">
								<td class={cn(PINNED, 'py-3 text-sm whitespace-nowrap text-ink-2')}>
									{formatDateLong(record.recordTimestamp)}
								</td>
								<td class="py-3 pr-8 text-right whitespace-nowrap"
									><Measure
										value={recordValue(record.primaryValue, record.primaryUnit)}
										numberClass="font-medium"
										unitClass="ml-[0.25em] text-sm text-ink-3"
									/></td
								>
								<td class="py-3 pr-8 whitespace-nowrap">
									{record.sourceApplication ?? record.sourcePlatform ?? '−'}
								</td>
								<td class="py-3 pr-8 whitespace-nowrap">{record.sourceDevice ?? '−'}</td>
								<td class="py-3 pr-8 whitespace-nowrap">{record.recordingMethod ?? '−'}</td>
								<td class="min-w-56 py-3">
									{#if record.payload.kind === 'fields' && record.payload.fields.length > 0}
										<details>
											<summary
												class="cursor-pointer text-sm font-medium underline decoration-rule-2 underline-offset-4 transition-colors duration-(--dur-micro) hover:decoration-sun"
											>
												{m.health_details()}
											</summary>
											<dl class="mt-2 grid gap-2">
												{#each record.payload.fields as field (`${field.path.join('.')}:${String(field.value)}`)}
													<div>
														<dt class="text-sm text-ink-3">
															{payloadPath(field.path, m.health_value())}
														</dt>
														<dd class="break-words">{payloadValue(field.value)}</dd>
													</div>
												{/each}
											</dl>
										</details>
									{:else}
										<span class="text-sm text-ink-3">{m.health_payload_unavailable()}</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if nextCursor !== null || loadingMore}
			<div class="mt-5">
				<Button variant="outline" disabled={loadingMore} onclick={loadMore}>
					{#if loadingMore}
						<Spinner data-icon="inline-start" />
						{m.health_loading_more()}
					{:else}
						{m.health_load_more()}
					{/if}
				</Button>
			</div>
		{/if}
	</section>
{/if}
