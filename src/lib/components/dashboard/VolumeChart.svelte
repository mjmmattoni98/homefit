<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCompact } from '#lib/format.js';
	import { CHART_COLORS, sparseTicks, timeAxis, tooltipDate } from '#lib/charts.js';

	let {
		data,
		unit,
		tooltipLabel = tooltipDate
	}: {
		/** One bar per entry, oldest first. */
		data: { date: Date; volume: number }[];
		/** Custom label/unit for the bar series (defaults to localized volume kg). */
		unit?: string;
		/** Tooltip heading for a bar's date. */
		tooltipLabel?: (date: Date) => string;
	} = $props();

	const seriesLabel = $derived(unit ?? m.volume_kg());
	const config = $derived({
		volume: { label: seriesLabel, color: CHART_COLORS.volume }
	} satisfies Chart.ChartConfig);

	const PADDING = { left: 44, right: 4, top: 8, bottom: 28 };
	// d3's band scale with the chart's default padding of 0.4 on every side of each bar.
	const BAND_PADDING = 0.4;
	const MAX_BAR = 22;

	let width = $state(0);
	// Bars keep the band's width until it passes 22px, so a handful of sessions don't turn into
	// slabs.
	const barWidth = $derived.by(() => {
		if (width === 0 || data.length === 0) return undefined;
		const step = (width - PADDING.left - PADDING.right) / (data.length + BAND_PADDING);
		return step * (1 - BAND_PADDING) > MAX_BAR ? MAX_BAR : undefined;
	});
</script>

<!-- Square bars in sun standing on an ink baseline, like the day's volume on the overview's
     horizon; hairline gridlines behind them. -->
<div bind:clientWidth={width}>
	<Chart.Container
		{config}
		class="h-[260px] w-full [&_.lc-axis-tick-label]:fill-ink-3 [&_.lc-grid-y-rule]:stroke-rule!"
	>
		<BarChart
			{data}
			x="date"
			padding={PADDING}
			bandPadding={BAND_PADDING}
			series={[
				{
					key: 'volume',
					label: seriesLabel,
					color: 'var(--color-volume)',
					props: { radius: 0, rounded: 'none', stroke: 'none', width: barWidth }
				}
			]}
			props={{
				xAxis: { ticks: sparseTicks(4), tickLength: 8, ...timeAxis(data) },
				// The ink baseline is zero, so it goes unlabelled and the first date has room.
				yAxis: {
					ticks: 3,
					tickLength: 8,
					format: (v: unknown) => (Number(v) === 0 ? '' : formatCompact(Number(v)))
				},
				grid: { yTicks: 3 },
				rule: { class: 'stroke-ink! [stroke-width:1.5px]!' }
			}}
		>
			{#snippet tooltip()}
				<Chart.Tooltip
					labelFormatter={(value: unknown) =>
						value instanceof Date ? tooltipLabel(value) : String(value)}
				/>
			{/snippet}
		</BarChart>
	</Chart.Container>
</div>
