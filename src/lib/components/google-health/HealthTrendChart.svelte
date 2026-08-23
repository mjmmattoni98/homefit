<script lang="ts">
	import { AreaChart } from 'layerchart';
	import { curveMonotoneX } from 'd3-shape';
	import * as Chart from '$lib/components/ui/chart';
	import * as m from '$lib/paraglide/messages';
	import { CHART_COLORS } from '$lib/charts';
	import { formatCompact, formatDateAxis } from '$lib/format';
	import { metricLabel } from '$lib/google-health/labels';
	import { summaryNumber, type HealthMetric, type HealthSummary } from '$lib/google-health/view';

	type Props = {
		metric: Pick<HealthMetric, 'dataType' | 'aggregation' | 'primaryUnit'>;
		summaries: HealthSummary[];
	};

	let { metric, summaries }: Props = $props();

	const chartUnit = $derived(metric.aggregation === 'duration' ? 'h' : metric.primaryUnit);
	const data = $derived(
		summaries.flatMap((summary) => {
			const rawValue = summaryNumber(metric, summary);
			if (rawValue === null) return [];
			return [
				{
					date: new Date(`${summary.localDate}T12:00:00.000Z`),
					value: metric.aggregation === 'duration' ? rawValue / 3600 : rawValue
				}
			];
		})
	);
	const config = $derived({
		value: {
			label:
				chartUnit === null || chartUnit.length === 0
					? metricLabel(metric.dataType)
					: `${metricLabel(metric.dataType)} (${chartUnit})`,
			color: CHART_COLORS.weight
		}
	} satisfies Chart.ChartConfig);
</script>

{#if data.length === 0}
	<div
		class="flex h-[260px] items-center justify-center rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
	>
		{m.health_no_trend()}
	</div>
{:else}
	<Chart.Container {config} class="h-[260px] w-full">
		<AreaChart
			{data}
			x="date"
			series={[
				{
					key: 'value',
					label: metricLabel(metric.dataType),
					color: 'var(--color-value)',
					props: {
						curve: curveMonotoneX,
						fillOpacity: 0.15,
						line: { class: 'stroke-2' }
					}
				}
			]}
			props={{
				xAxis: {
					format: (value: unknown) =>
						value instanceof Date ? formatDateAxis(value.getTime()) : String(value)
				},
				yAxis: {
					format: (value: unknown) =>
						`${formatCompact(Number(value))}${chartUnit ? ` ${chartUnit}` : ''}`
				}
			}}
		>
			{#snippet tooltip()}
				<Chart.Tooltip />
			{/snippet}
		</AreaChart>
	</Chart.Container>
{/if}
