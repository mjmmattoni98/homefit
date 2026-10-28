<script lang="ts">
	import { AreaChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { CHART_COLORS, timeAxis, tooltipDate } from '#lib/charts.js';

	let { data }: { data: { date: Date; quality: number | undefined }[] } = $props();

	const config = {
		quality: { label: m.quality(), color: CHART_COLORS.quality }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container {config} class="h-[260px] w-full">
	<AreaChart
		{data}
		x="date"
		yDomain={[0, 100]}
		series={[
			{
				key: 'quality',
				label: m.quality(),
				color: 'var(--color-quality)',
				props: {
					curve: curveMonotoneX,
					fillOpacity: 0.15,
					line: { class: 'stroke-2' },
					defined: (d: { quality?: number }) => d.quality != null
				}
			}
		]}
		props={{ xAxis: timeAxis(data) }}
	>
		{#snippet tooltip()}
			<Chart.Tooltip labelFormatter={tooltipDate} />
		{/snippet}
	</AreaChart>
</Chart.Container>
