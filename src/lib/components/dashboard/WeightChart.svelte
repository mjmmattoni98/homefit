<script lang="ts">
	import { LineChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '$lib/components/ui/chart';
	import { formatDateAxis } from '$lib/format';
	import { CHART_COLORS } from '$lib/charts';

	let { data }: { data: { date: Date; weight: number | undefined }[] } = $props();

	const config = {
		weight: { label: 'kg', color: CHART_COLORS.weight }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container {config} class="h-[260px] w-full">
	<LineChart
		{data}
		x="date"
		series={[
			{
				key: 'weight',
				label: 'kg',
				color: 'var(--color-weight)',
				props: {
					curve: curveMonotoneX,
					class: 'stroke-2',
					defined: (d: { weight?: number }) => d.weight != null
				}
			}
		]}
		props={{
			xAxis: {
				format: (v: unknown) => (v instanceof Date ? formatDateAxis(v.getTime()) : String(v))
			}
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip />
		{/snippet}
	</LineChart>
</Chart.Container>
