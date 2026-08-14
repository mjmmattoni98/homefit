<script lang="ts">
	import { BarChart } from 'layerchart';
	import * as Chart from '$lib/components/ui/chart';
	import * as m from '$lib/paraglide/messages';
	import { formatCompact } from '$lib/format';
	import { CHART_COLORS, sparseTicks } from '$lib/charts';

	let { data }: { data: { label: string; volume: number }[] } = $props();

	const config = {
		volume: { label: m.volume_kg(), color: CHART_COLORS.volume }
	} satisfies Chart.ChartConfig;
</script>

<Chart.Container {config} class="h-[260px] w-full">
	<BarChart
		{data}
		x="label"
		series={[
			{
				key: 'volume',
				label: m.volume_kg(),
				color: 'var(--color-volume)',
				props: { radius: 3, rounded: 'top' }
			}
		]}
		props={{
			xAxis: { ticks: sparseTicks(6) },
			yAxis: { format: (v: unknown) => formatCompact(Number(v)) }
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip hideLabel />
		{/snippet}
	</BarChart>
</Chart.Container>
