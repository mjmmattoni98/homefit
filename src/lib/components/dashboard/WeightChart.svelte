<script lang="ts">
	import { LineChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import { CHART_COLORS, timeAxis, tooltipDate } from '#lib/charts.js';

	let { data }: { data: { date: Date; weight: number }[] } = $props();

	const config = {
		weight: { label: 'kg', color: CHART_COLORS.weight }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container
	{config}
	class="h-[260px] w-full [&_.lc-axis-tick-label]:fill-ink-3 [&_.lc-grid-y-rule]:stroke-rule!"
>
	<!-- Not anchored at zero, so progress of a few kilos stays visible. The domain is rounded to the
	     same three to five gridlines the axis labels, so the line never runs past the top one. A dot
	     marks each session, including ones far apart from the rest; a ring of the day ground keeps
	     neighbours apart. -->
	<LineChart
		{data}
		x="date"
		yBaseline={undefined}
		yNice={3}
		padding={{ left: 44, right: 8, top: 8, bottom: 28 }}
		points={{ r: 3, stroke: 'var(--color-day)', strokeWidth: 1.5 }}
		series={[
			{
				key: 'weight',
				label: 'kg',
				color: 'var(--color-weight)',
				props: { curve: curveMonotoneX, class: 'stroke-2' }
			}
		]}
		props={{
			xAxis: { tickLength: 8, ...timeAxis(data) },
			yAxis: { ticks: 3, tickLength: 8 },
			grid: { yTicks: 3 }
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip labelFormatter={tooltipDate} />
		{/snippet}
	</LineChart>
</Chart.Container>
