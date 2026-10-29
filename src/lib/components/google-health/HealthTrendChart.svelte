<script lang="ts">
	import { BarChart, LineChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { sparseTicks, timeAxis, tooltipDate } from '#lib/charts.js';
	import { formatCompact } from '#lib/format.js';
	import { metricLabel } from '#lib/google-health/labels.js';
	import {
		summaryNumber,
		type HealthCategory,
		type HealthMetric,
		type HealthSummary
	} from '#lib/google-health/view.js';
	import { cn } from '#lib/utils.js';

	type Props = {
		metric: Pick<HealthMetric, 'dataType' | 'aggregation' | 'primaryUnit'> & {
			category?: HealthCategory;
		};
		summaries: HealthSummary[];
	};

	let { metric, summaries }: Props = $props();

	const PADDING = { left: 48, right: 16, top: 16, bottom: 30 };
	const MAX_BAR = 22;
	// Dots mark each day while there are few enough of them to tell apart.
	const MAX_POINTS = 45;

	let width = $state(0);

	// Sleep is drawn in moonlight; the page puts it on a night panel.
	const night = $derived(metric.category === 'sleep');
	// The sun is kept for training and the day's activity; other measurements are drawn in ink.
	const color = $derived(
		night
			? 'var(--color-sleep)'
			: metric.category === 'activity'
				? 'var(--color-sun)'
				: 'var(--color-ink-2)'
	);
	// Daily totals are bars from zero; levels (a weight, a resting rate) are a line that is not
	// anchored at zero, so a change of a few units stays visible.
	const bars = $derived(metric.aggregation === 'sum' || metric.aggregation === 'duration');

	const chartUnit = $derived(metric.aggregation === 'duration' ? 'h' : metric.primaryUnit);
	const label = $derived(metricLabel(metric.dataType));
	const data = $derived(
		summaries.flatMap((summary) => {
			const rawValue = summaryNumber(metric, summary);
			if (rawValue === null) return [];
			return [
				{
					date: new Date(`${summary.localDate}T12:00:00.000Z`),
					value: metric.aggregation === 'duration' ? rawValue / 3600 : rawValue
				}
			];
		})
	);
	// The unit is named once, above the axis, so the tooltip only repeats it when the metric's
	// name does not already say it ("Steps", not "Steps (steps)").
	const config = $derived({
		value: {
			label:
				chartUnit === null ||
				chartUnit.length === 0 ||
				label.toLowerCase().includes(chartUnit.toLowerCase())
					? label
					: `${label} (${chartUnit})`,
			color
		}
	} satisfies Chart.ChartConfig);

	// Bars stay at most 22px wide however few days are shown.
	const bandPadding = $derived.by(() => {
		const step = (width - PADDING.left - PADDING.right) / Math.max(1, data.length);
		return step <= 0 ? 0.35 : Math.min(0.9, Math.max(0.35, 1 - MAX_BAR / step));
	});

	// Three to five gridlines, whatever the range; the grid and the axis share them.
	const yTicks = (scale: { ticks?: (count?: number) => unknown[] }) => {
		const ticks = scale.ticks?.(4) ?? [];
		return ticks.length > 5 ? (scale.ticks?.(3) ?? ticks) : ticks;
	};
	const yAxis = { ticks: yTicks, format: (value: unknown) => formatCompact(Number(value)) };
	const grid = { yTicks };
	// Dates hang a little lower than the zero line's label, so the two never touch.
	const X_TICK_LENGTH = 10;
	const containerClass = $derived(
		cn(
			'h-[260px] w-full',
			'[&_.lc-grid-y-rule]:[--stroke-color:var(--color-rule)]',
			night &&
				'[&_.lc-axis-tick-label]:fill-moon-2 [&_.lc-grid-y-rule]:[--stroke-color:var(--color-night-rule)]'
		)
	);
</script>

{#if data.length === 0}
	<div
		class={cn(
			'flex h-[260px] items-end border-b pb-3 text-sm',
			night ? 'border-night-rule text-moon-2' : 'border-rule text-ink-3'
		)}
	>
		{m.health_no_trend()}
	</div>
{:else}
	<div bind:clientWidth={width}>
		<!-- The unit names the axis once, so the ticks stay short enough for a phone. -->
		{#if chartUnit}
			<p class={cn('mb-1 text-xs', night ? 'text-moon-2' : 'text-ink-3')}>{chartUnit}</p>
		{/if}
		<Chart.Container {config} class={containerClass}>
			{#if bars}
				<BarChart
					{data}
					x="date"
					padding={PADDING}
					{bandPadding}
					series={[
						{
							key: 'value',
							label,
							color: 'var(--color-value)',
							props: { radius: 0, stroke: 'none' }
						}
					]}
					props={{
						xAxis: {
							ticks: sparseTicks(width < 480 ? 3 : 6),
							tickLength: X_TICK_LENGTH,
							...timeAxis(data)
						},
						yAxis,
						grid
					}}
				>
					{#snippet tooltip()}
						<Chart.Tooltip labelFormatter={tooltipDate} />
					{/snippet}
				</BarChart>
			{:else}
				<LineChart
					{data}
					x="date"
					padding={PADDING}
					xPadding={[16, 16]}
					yBaseline={undefined}
					yNice
					points={data.length <= MAX_POINTS ? { r: 3 } : false}
					series={[
						{
							key: 'value',
							label,
							color: 'var(--color-value)',
							props: { curve: curveMonotoneX, class: 'stroke-2' }
						}
					]}
					props={{
						xAxis: { tickLength: X_TICK_LENGTH, ...timeAxis(data) },
						yAxis,
						grid,
						points: { stroke: night ? 'var(--color-night)' : 'var(--color-day)' }
					}}
				>
					{#snippet tooltip()}
						<Chart.Tooltip labelFormatter={tooltipDate} />
					{/snippet}
				</LineChart>
			{/if}
		</Chart.Container>
	</div>
{/if}
