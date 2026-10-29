<script lang="ts">
	import { resolve } from '$app/paths';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDateLong, splitUnit } from '#lib/format.js';
	import { metricLabel } from '#lib/google-health/labels.js';
	import {
		formatDuration,
		formatMetricNumber,
		formatSummaryValue,
		summaryNumber,
		trendDelta,
		type HealthMetric,
		type HealthSummary
	} from '#lib/google-health/view.js';
	import Sparkline from '#lib/components/dashboard/Sparkline.svelte';
	import { cn } from '#lib/utils.js';
	import ArrowDownRightIcon from '@lucide/svelte/icons/arrow-down-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

	type Props = {
		metric: HealthMetric;
		trend?: HealthSummary[];
	};

	let { metric, trend = [] }: Props = $props();

	const DAY_MS = 24 * 60 * 60 * 1000;

	const title = $derived(metricLabel(metric.dataType));
	const value = $derived(formatSummaryValue(metric, metric.latestSummary, m.health_recorded()));
	const parts = $derived(splitUnit(value));
	// "Recorded" and "−" are words, not figures, so they keep the body face.
	const isFigure = $derived(/\d/.test(parts.number));
	const delta = $derived(trendDelta(metric, trend));
	const deltaValue = $derived.by(() => {
		if (delta === null) return null;
		const amount =
			metric.aggregation === 'duration'
				? formatDuration(Math.abs(delta))
				: formatMetricNumber(Math.abs(delta), metric.primaryUnit);
		return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${amount}`;
	});
	const lastRecorded = $derived(
		metric.latestSummary.latestTimestamp ??
			new Date(`${metric.latestSummary.localDate}T00:00:00.000Z`).getTime()
	);

	// Sleep is measured on the nights, so its rows carry the night field with them.
	const night = $derived(metric.category === 'sleep');
	// Rows given a trend fill two more columns of the ledger: the trend and its last change.
	const hasTrend = $derived(trend.length > 0);

	// One slot per calendar day from the first summary to the last, so a gap keeps its width.
	const sparkValues = $derived.by(() => {
		const points = trend.flatMap((summary) => {
			const number = summaryNumber(metric, summary);
			const day = Date.parse(`${summary.localDate}T00:00:00.000Z`);
			return number === null || Number.isNaN(day) ? [] : [{ day, number }];
		});
		if (points.length < 2) return [];
		const first = Math.min(...points.map((point) => point.day));
		const last = Math.max(...points.map((point) => point.day));
		const values = Array.from<number | null>({
			length: Math.round((last - first) / DAY_MS) + 1
		}).fill(null);
		for (const point of points) values[Math.round((point.day - first) / DAY_MS)] = point.number;
		return values;
	});
	const sparkKind = $derived(
		metric.aggregation === 'sum' || metric.aggregation === 'duration' ? 'bars' : 'line'
	);
</script>

<!-- One row of a ledger, and the whole row is the link. The page's grid sets the columns; the
     row takes them over through subgrid: the metric, [its trend], the latest figure, [the last
     change]. On phones the trend and the change drop to a second line. -->
<a
	href={resolve('/dashboard/health/metrics/[dataType]', { dataType: metric.dataType })}
	aria-label={m.health_open_metric({ metric: title })}
	class={cn(
		'group col-span-full grid grid-cols-subgrid items-center gap-y-2 py-3.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
		night && 'bg-night text-moon'
	)}
>
	<span class={cn('min-w-0', hasTrend && 'max-sm:order-1')}>
		<span
			class="block font-medium underline-offset-4 group-hover:underline group-hover:decoration-sun sm:truncate"
			>{title}</span
		>
		<span class={cn('block truncate text-sm', night ? 'text-moon-2' : 'text-ink-3')}
			>{m.health_source()}: {metric.sourceLabel}</span
		>
	</span>

	{#if hasTrend}
		<span class="min-w-0 max-sm:order-3">
			{#if sparkValues.length > 0}
				<Sparkline
					values={sparkValues}
					kind={sparkKind}
					color={night
						? 'var(--color-sleep)'
						: metric.category === 'activity'
							? 'var(--color-sun)'
							: 'var(--color-ink-2)'}
				/>
			{/if}
		</span>
	{/if}

	<span class={cn('min-w-0 text-right', hasTrend && 'max-sm:order-2')}>
		{#if isFigure}
			<span class="block whitespace-nowrap"
				><span class="text-2xl leading-none font-figure">{parts.number}</span>{parts.unit
					? ' '
					: ''}<span class={cn('text-sm', night ? 'text-moon-2' : 'text-ink-3')}>{parts.unit}</span
				></span
			>
		{:else}
			<span class={cn('block', night ? 'text-moon-2' : 'text-ink-2')}>{value}</span>
		{/if}
		<span class={cn('block text-sm whitespace-nowrap', night ? 'text-moon-2' : 'text-ink-3')}>
			{m.health_last_recorded({ date: formatDateLong(lastRecorded) })}
		</span>
	</span>

	{#if hasTrend}
		<span
			class={cn(
				'text-right text-sm whitespace-nowrap max-sm:order-4',
				night ? 'text-moon-2' : 'text-ink-2'
			)}
		>
			{#if deltaValue !== null}
				<span class="inline-flex items-center gap-0.5"
					>{#if delta !== null && delta > 0}<ArrowUpRightIcon
							class="size-3.5"
							aria-hidden="true"
						/>{:else if delta !== null && delta < 0}<ArrowDownRightIcon
							class="size-3.5"
							aria-hidden="true"
						/>{/if}{deltaValue}</span
				>
			{/if}
		</span>
	{/if}
</a>
