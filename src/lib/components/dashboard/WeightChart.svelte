<script lang="ts">
	import { LineChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '#lib/components/ui/chart/index.js';
	import { CHART_COLORS, timeAxis, tooltipDate } from '#lib/charts.js';

	let {
		data,
		unit = 'kg'
	}: {
		data: { date: Date; weight?: number; value?: number; pr?: boolean }[];
		unit?: string;
	} = $props();

	const normalized = $derived(
		data.map((point) => ({
			date: point.date,
			value: point.value ?? point.weight ?? 0,
			pr: point.pr ?? false
		}))
	);

	const config = $derived({
		value: { label: unit, color: CHART_COLORS.weight }
	} satisfies Chart.ChartConfig);
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
		data={normalized}
		x="date"
		yBaseline={undefined}
		yNice={3}
		padding={{ left: 44, right: 8, top: 8, bottom: 28 }}
		points={{ r: 3.5, stroke: 'var(--color-day)', strokeWidth: 1.5 }}
		series={[
			{
				key: 'value',
				label: unit,
				color: 'var(--color-value)',
				props: { curve: curveMonotoneX, class: 'stroke-2' }
			}
		]}
		props={{
			xAxis: { tickLength: 8, ...timeAxis(normalized) },
			yAxis: { ticks: 3, tickLength: 8 },
			grid: { yTicks: 3 }
		}}
	>
		{#snippet tooltip()}
			<Chart.Tooltip labelFormatter={tooltipDate} />
		{/snippet}
	</LineChart>
</Chart.Container>
