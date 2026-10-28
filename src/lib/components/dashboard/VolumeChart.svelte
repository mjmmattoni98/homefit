<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatCompact } from '#lib/format.js';
	import { CHART_COLORS, sparseTicks, timeAxis, tooltipDate } from '#lib/charts.js';

	let {
		data,
		tooltipLabel = tooltipDate
	}: {
		/** One bar per entry, oldest first. */
		data: { date: Date; volume: number }[];
		/** Tooltip heading for a bar's date. */
		tooltipLabel?: (date: Date) => string;
	} = $props();

	const config = {
		volume: { label: m.volume_kg(), color: CHART_COLORS.volume }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container {config} class="h-[260px] w-full">
	<BarChart
		{data}
		x="date"
		series={[
			{
				key: 'volume',
				label: m.volume_kg(),
				color: 'var(--color-volume)',
				props: { radius: 3, rounded: 'top', stroke: 'none' }
			}
		]}
		props={{
			xAxis: { ticks: sparseTicks(6), ...timeAxis(data) },
			yAxis: { format: (v: unknown) => formatCompact(Number(v)) }
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
