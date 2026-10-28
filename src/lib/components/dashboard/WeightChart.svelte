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

<Chart.Container {config} class="h-[260px] w-full">
	<!-- Not anchored at zero, so progress of a few kilos stays visible. A dot marks each session,
	     including ones far apart from the rest. -->
	<LineChart
		{data}
		x="date"
		yBaseline={undefined}
		yNice
		points={{ r: 3 }}
		series={[
			{
				key: 'weight',
				label: 'kg',
				color: 'var(--color-weight)',
				props: { curve: curveMonotoneX, class: 'stroke-2' }
			}
		]}
		props={{ xAxis: timeAxis(data) }}
	>
		{#snippet tooltip()}
			<Chart.Tooltip labelFormatter={tooltipDate} />
		{/snippet}
	</LineChart>
</Chart.Container>
