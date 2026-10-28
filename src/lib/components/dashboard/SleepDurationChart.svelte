<script lang="ts">
	import { AreaChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { CHART_COLORS, timeAxis, tooltipDate } from '#lib/charts.js';

	let { data }: { data: { date: Date; inBed: number | undefined; asleep: number | undefined }[] } =
		$props();

	const config = {
		inBed: { label: m.time_in_bed(), color: CHART_COLORS.inBed },
		asleep: { label: m.time_asleep(), color: CHART_COLORS.asleep }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container {config} class="h-[260px] w-full">
	<!-- Both series are hours of the same night, so they overlap rather than stack. -->
	<AreaChart
		{data}
		x="date"
		seriesLayout="overlap"
		series={[
			{
				key: 'inBed',
				label: m.time_in_bed(),
				color: 'var(--color-inBed)',
				props: {
					curve: curveMonotoneX,
					fillOpacity: 0,
					line: { class: 'stroke-2 stroke-dashed' },
					defined: (d: { inBed?: number }) => d.inBed != null
				}
			},
			{
				key: 'asleep',
				label: m.time_asleep(),
				color: 'var(--color-asleep)',
				props: {
					curve: curveMonotoneX,
					fillOpacity: 0.2,
					line: { class: 'stroke-2' },
					defined: (d: { asleep?: number }) => d.asleep != null
				}
			}
		]}
		props={{
			xAxis: timeAxis(data),
			yAxis: { format: (v: unknown) => `${v} h` }
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip labelFormatter={tooltipDate} />
		{/snippet}
	</AreaChart>
</Chart.Container>
