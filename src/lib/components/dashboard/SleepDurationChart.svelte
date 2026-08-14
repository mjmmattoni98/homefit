<script lang="ts">
	import { AreaChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '$lib/components/ui/chart';
	import * as m from '$lib/paraglide/messages';
	import { formatDateAxis } from '$lib/format';
	import { CHART_COLORS } from '$lib/charts';

	let { data }: { data: { date: Date; inBed: number | undefined; asleep: number | undefined }[] } =
		$props();

	const config = {
		inBed: { label: m.time_in_bed(), color: CHART_COLORS.inBed },
		asleep: { label: m.time_asleep(), color: CHART_COLORS.asleep }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container {config} class="h-[260px] w-full">
	<AreaChart
		{data}
		x="date"
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
			xAxis: {
				format: (v: unknown) => (v instanceof Date ? formatDateAxis(v.getTime()) : String(v))
			},
			yAxis: { format: (v: unknown) => `${v} h` }
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip />
		{/snippet}
	</AreaChart>
</Chart.Container>
