<script lang="ts">
	import { formatHours, formatNumber, formatSigned } from '#lib/format.js';
	import { CHART_COLORS } from '#lib/charts.js';
	import type { ChartPoint, PeriodSummary } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import Measure from '#lib/components/Measure.svelte';
	import Sparkline from './Sparkline.svelte';
	import ArrowDownRightIcon from '@lucide/svelte/icons/arrow-down-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

	let {
		summary,
		points,
		comparedWith,
		side
	}: {
		summary: PeriodSummary;
		/** The chart's points, drawn as each figure's sparkline. */
		points: ChartPoint[];
		/** What changes are measured against, e.g. "vs previous 30 days". */
		comparedWith: string;
		/** The day's figures (training) sit above the horizon, the night's (sleep) below it. */
		side: 'day' | 'night';
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
	};

	const dayFigures = $derived<Figure[]>([
		{
			label: m.kpi_workouts(),
			value: formatNumber(summary.workouts),
			change: summary.workoutsChange,
			unit: 'relative',
			hint: m.kpi_training_days({ count: summary.trainingDays }),
			spark: points.map((point) => point.workouts),
			kind: 'bars'
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
			kind: 'bars'
		}
	]);

	const nightFigures = $derived<Figure[]>([
		{
			label: m.kpi_quality(),
			value: summary.quality === null ? '—' : `${Math.round(summary.quality)}%`,
			change: summary.qualityChange,
			unit: 'points',
			hint: m.nights_count({ count: summary.nights.length }),
			spark: points.map((point) => point.quality),
			kind: 'line'
		},
		{
			label: m.time_asleep(),
			value: summary.asleep === null ? '—' : formatHours(summary.asleep),
			change: summary.asleepChange,
			unit: 'relative',
			hint: summary.inBed === null ? '' : m.kpi_in_bed({ hours: formatHours(summary.inBed) }),
			spark: points.map((point) => point.asleep),
			kind: 'line'
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
			kind: 'line'
		}
	]);

	const figures = $derived(side === 'day' ? dayFigures : nightFigures);
	const night = $derived(side === 'night');
</script>

{#snippet change(figure: Figure)}
	{#if figure.change !== null}
		{@const shown =
			figure.unit === 'points' ? Number(figure.change.toFixed(1)) : Math.round(figure.change * 100)}
		<span
			class={cn(
				'inline-flex items-center gap-0.5 text-sm',
				night ? 'text-moon-2' : 'text-ink-2',
				shown === 0 && (night ? 'text-moon-2/80' : 'text-ink-3')
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

<!-- Figures without boxes: a label, the figure in the condensed cut, then what it is measured
     against. -->
<dl
	aria-label={m.kpi_section_label()}
	class={cn(
		'grid gap-x-8 gap-y-7',
		night ? 'grid-cols-2 sm:grid-cols-3 sm:gap-x-12' : 'grid-cols-2 sm:gap-x-12 lg:w-[36rem]'
	)}
>
	{#each figures as figure (figure.label)}
		<div class="flex min-w-0 flex-col gap-1">
			<dt class={cn('text-sm', night ? 'text-moon-2' : 'text-ink-3')}>{figure.label}</dt>
			<dd class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<Measure
					value={figure.value}
					class="text-4xl font-figure sm:text-5xl"
					unitClass={cn(
						'ml-[0.2em] text-[0.45em] font-medium',
						night ? 'text-moon-2' : 'text-ink-3'
					)}
				/>
				{@render change(figure)}
			</dd>
			<dd class="mt-1.5 mb-0.5 max-w-[18rem]" aria-hidden="true">
				<Sparkline
					values={figure.spark}
					kind={figure.kind}
					color={night ? CHART_COLORS.quality : CHART_COLORS.volume}
				/>
			</dd>
			{#if figure.hint}
				<dd class={cn('text-sm text-pretty', night ? 'text-moon-2' : 'text-ink-3')}>
					{figure.hint}
				</dd>
			{/if}
		</div>
	{/each}
</dl>
