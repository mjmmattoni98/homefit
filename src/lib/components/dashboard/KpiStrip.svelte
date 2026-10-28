<script lang="ts">
	import { CHART_COLORS } from '#lib/charts.js';
	import { formatHours, formatNumber, formatSigned } from '#lib/format.js';
	import type { ChartPoint, PeriodSummary } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import Sparkline from './Sparkline.svelte';
	import ArrowDownRightIcon from '@lucide/svelte/icons/arrow-down-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

	let {
		summary,
		points,
		comparedWith
	}: {
		summary: PeriodSummary;
		/** The chart's points, drawn as each figure's sparkline. */
		points: ChartPoint[];
		/** What changes are measured against, e.g. "vs previous 30 days". */
		comparedWith: string;
	} = $props();

	type Figure = {
		label: string;
		value: string;
		/** Change against the previous period, in points or relative (0.05 = 5 % more). */
		change: number | null;
		unit: 'points' | 'relative';
		hint: string;
		spark: (number | null)[];
		kind: 'line' | 'bars';
		color: string;
		/** Grid placement: the strip wraps to two rows on phones and tablets. */
		span: string;
	};

	const figures = $derived<Figure[]>([
		{
			label: m.kpi_quality(),
			value: summary.quality === null ? '—' : `${Math.round(summary.quality)}%`,
			change: summary.qualityChange,
			unit: 'points',
			hint: m.nights_count({ count: summary.nights.length }),
			spark: points.map((point) => point.quality),
			kind: 'line',
			color: CHART_COLORS.quality,
			span: 'col-span-2 sm:col-span-3 lg:col-span-1'
		},
		{
			label: m.time_asleep(),
			value: summary.asleep === null ? '—' : formatHours(summary.asleep),
			change: summary.asleepChange,
			unit: 'relative',
			hint: summary.inBed === null ? '' : m.kpi_in_bed({ hours: formatHours(summary.inBed) }),
			spark: points.map((point) => point.asleep),
			kind: 'line',
			color: CHART_COLORS.asleep,
			span: 'sm:col-span-3 lg:col-span-1'
		},
		{
			label: m.kpi_efficiency(),
			value: summary.efficiency === null ? '—' : `${Math.round(summary.efficiency)}%`,
			change: summary.efficiencyChange,
			unit: 'points',
			hint: m.kpi_efficiency_hint(),
			spark: points.map((point) =>
				point.asleep !== null && point.inBed ? (point.asleep / point.inBed) * 100 : null
			),
			kind: 'line',
			color: CHART_COLORS.asleep,
			span: 'sm:col-span-2 lg:col-span-1'
		},
		{
			label: m.kpi_workouts(),
			value: formatNumber(summary.workouts),
			change: summary.workoutsChange,
			unit: 'relative',
			hint: m.kpi_training_days({ count: summary.trainingDays }),
			spark: points.map((point) => point.workouts),
			kind: 'bars',
			color: CHART_COLORS.volume,
			span: 'sm:col-span-2 lg:col-span-1'
		},
		{
			label: m.kpi_volume(),
			value: `${formatNumber(summary.volume)} kg`,
			change: summary.volumeChange,
			unit: 'relative',
			hint:
				summary.workouts === 0
					? ''
					: m.kpi_per_workout({ volume: formatNumber(summary.volume / summary.workouts) }),
			spark: points.map((point) => point.volume),
			kind: 'bars',
			color: CHART_COLORS.volume,
			span: 'sm:col-span-2 lg:col-span-1'
		}
	]);
</script>

{#snippet change(figure: Figure)}
	{#if figure.change !== null}
		{@const shown =
			figure.unit === 'points' ? Number(figure.change.toFixed(1)) : Math.round(figure.change * 100)}
		<!-- Every figure is better when it goes up, so up is green. -->
		<span
			class={cn(
				'inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium tabular-nums',
				shown > 0 && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
				shown < 0 && 'bg-red-500/10 text-red-700 dark:text-red-400',
				shown === 0 && 'bg-muted text-muted-foreground'
			)}
			title={comparedWith}
		>
			{#if shown > 0}
				<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
			{:else if shown < 0}
				<ArrowDownRightIcon class="size-3.5" aria-hidden="true" />
			{/if}
			{figure.unit === 'points'
				? m.points_short({ value: formatSigned(figure.change, 1) })
				: `${formatSigned(figure.change * 100)}%`}
			<span class="sr-only">{comparedWith}</span>
		</span>
	{/if}
{/snippet}

<section
	aria-label={m.kpi_section_label()}
	class="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-6 lg:grid-cols-5"
>
	{#each figures as figure (figure.label)}
		<div class={cn('flex min-w-0 flex-col gap-1.5 bg-card p-3 sm:p-4', figure.span)}>
			<span class="truncate text-xs font-medium text-muted-foreground">{figure.label}</span>
			<div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
				<span class="text-2xl font-semibold tracking-tight tabular-nums">{figure.value}</span>
				{@render change(figure)}
			</div>
			<Sparkline values={figure.spark} kind={figure.kind} color={figure.color} />
			<span class="truncate text-xs text-muted-foreground tabular-nums">{figure.hint}</span>
		</div>
	{/each}
</section>
