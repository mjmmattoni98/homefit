<script lang="ts">
	import { CHART_COLORS } from '#lib/charts.js';
	import { dayToDate } from '#lib/days.js';
	import { formatCompact, formatDate, formatHours, formatNumber } from '#lib/format.js';
	import { TREND_DAYS, type ChartPoint, type Granularity } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { curveMonotoneX, line } from 'd3-shape';

	let {
		points,
		granularity,
		average
	}: {
		/** Oldest first. */
		points: ChartPoint[];
		granularity: Granularity;
		/** Mean quality over the period, drawn as a reference line. */
		average: number | null;
	} = $props();

	// Each column is one day (or week, or month): its training rises above the horizon and the
	// sleep that began that evening hangs below it. The halves have different units, so each keeps
	// its own zero (the horizon) and its own scale, labelled on its own side.
	const DAY = 150;
	const NIGHT = 176;
	const LABELS = 30;
	const HEIGHT = DAY + NIGHT + LABELS;
	const LEFT = 52;
	const RIGHT = 12;
	const READOUT_WIDTH = 200;

	let width = $state(0);
	let active = $state<number | null>(null);

	const innerWidth = $derived(Math.max(0, width - LEFT - RIGHT));
	const step = $derived(points.length === 0 ? 0 : innerWidth / points.length);
	const x = (index: number) => LEFT + (index + 0.5) * step;
	const barWidth = $derived(Math.max(1, Math.min(22, step * 0.62)));

	const maxVolume = $derived(Math.max(1, ...points.map((point) => point.volume)));
	// Volume fills at most nine tenths of the day; quality runs from 0 to 100 down the night.
	const rise = (volume: number) => (volume / maxVolume) * DAY * 0.9;
	const drop = (quality: number) => (quality / 100) * (NIGHT - 14);
	const nightY = (quality: number) => DAY + drop(quality);

	const trendPath = $derived(
		line<ChartPoint>()
			.defined((point) => point.trend !== null)
			.x((_, index) => x(index))
			.y((point) => nightY(point.trend ?? 0))
			.curve(curveMonotoneX)(points) ?? ''
	);

	const xTicks = $derived.by(() => {
		const count = Math.max(2, Math.floor(innerWidth / (granularity === 'day' ? 96 : 116)));
		const stride = Math.max(1, Math.ceil(points.length / count));
		return points.flatMap((point, index) => (index % stride === 0 ? [{ point, index }] : []));
	});

	const time = (point: ChartPoint) => dayToDate(point.from).getTime();
	const tickLabel = (point: ChartPoint) =>
		granularity === 'day'
			? formatDate(time(point))
			: formatDate(time(point), { month: 'short', year: 'numeric' });
	const pointLabel = (point: ChartPoint) => {
		if (granularity === 'day') {
			return formatDate(time(point), { weekday: 'short', day: 'numeric', month: 'short' });
		}
		if (granularity === 'week') return m.week_of({ date: formatDate(time(point)) });
		return formatDate(time(point), { month: 'long', year: 'numeric' });
	};
	const trendLabel = $derived(m.chart_trend({ days: TREND_DAYS[granularity] }));

	const activePoint = $derived(active === null ? null : points[active]);
	// Beside the column, on whichever side has room, so it never hides the inspected day.
	const readoutLeft = $derived.by(() => {
		if (active === null) return 0;
		const right = x(active) + barWidth / 2 + 12;
		return right + READOUT_WIDTH <= width
			? right
			: Math.max(0, x(active) - barWidth / 2 - 12 - READOUT_WIDTH);
	});

	// What a screen reader announces for the inspected point.
	const valueText = $derived.by(() => {
		const point = points[active ?? points.length - 1];
		if (point === undefined) return '';
		return m.chart_value_text({
			date: pointLabel(point),
			quality:
				point.quality === null
					? m.chart_value_untracked()
					: m.chart_value_quality({ value: Math.round(point.quality) }),
			workouts: point.workouts,
			volume: formatNumber(point.volume)
		});
	});

	function pick(clientX: number, target: SVGSVGElement): void {
		if (points.length === 0) return;
		const offset = clientX - target.getBoundingClientRect().left - LEFT;
		active = Math.min(points.length - 1, Math.max(0, Math.floor(offset / step)));
	}

	function onkeydown(event: KeyboardEvent): void {
		const last = points.length - 1;
		const current = active ?? last;
		const targets: Partial<Record<string, number>> = {
			ArrowLeft: current - 1,
			ArrowRight: current + 1,
			Home: 0,
			End: last
		};
		const next = targets[event.key];
		if (next === undefined) return;
		event.preventDefault();
		active = Math.min(last, Math.max(0, next));
	}
</script>

<!-- The night field starts at the horizon and runs to both edges of the window. -->
<div class="relative col-[full] grid grid-cols-subgrid">
	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 bg-night"
		style:top="{DAY}px"
		aria-hidden="true"
	></div>

	<!-- A slider over the points, so keyboard and screen reader users can inspect them too. -->
	<div
		class="relative col-[content] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
		bind:clientWidth={width}
		role="slider"
		aria-label={m.chart_label()}
		aria-valuemin={0}
		aria-valuemax={Math.max(0, points.length - 1)}
		aria-valuenow={active ?? points.length - 1}
		aria-valuetext={valueText}
		tabindex="0"
		{onkeydown}
		onfocus={() => (active ??= points.length - 1)}
		onblur={() => (active = null)}
	>
		<svg
			width={width || undefined}
			height={HEIGHT}
			class="block w-full touch-pan-y select-none"
			aria-hidden="true"
			onpointermove={(event) => pick(event.clientX, event.currentTarget)}
			onpointerdown={(event) => pick(event.clientX, event.currentTarget)}
			onpointerleave={() => (active = null)}
		>
			{#if width > 0}
				<!-- Day scale: one line at the largest volume. -->
				<line
					x1={LEFT}
					x2={width - RIGHT}
					y1={DAY - rise(maxVolume)}
					y2={DAY - rise(maxVolume)}
					class="stroke-rule"
				/>
				<text
					x={LEFT - 10}
					y={DAY - rise(maxVolume)}
					dy="0.32em"
					text-anchor="end"
					class="fill-ink-3 text-xs">{formatCompact(Math.round(maxVolume))}</text
				>
				<text x={LEFT - 10} y={DAY - 8} text-anchor="end" class="fill-ink-3 text-xs">kg</text>

				<!-- Night scale: half and full quality. -->
				{#each [50, 100] as tick (tick)}
					<line
						x1={LEFT}
						x2={width - RIGHT}
						y1={nightY(tick)}
						y2={nightY(tick)}
						class="stroke-night-rule"
					/>
					<text
						x={LEFT - 10}
						y={nightY(tick)}
						dy="0.32em"
						text-anchor="end"
						class="fill-moon-2 text-xs">{tick}%</text
					>
				{/each}

				{#if active !== null}
					<rect x={x(active) - step / 2} y={0} width={step} height={DAY} class="fill-ink/6" />
					<rect x={x(active) - step / 2} y={DAY} width={step} height={NIGHT} class="fill-moon/10" />
				{/if}

				{#each points as point, index (point.from)}
					{@const dim = active !== null && active !== index}
					{#if point.volume > 0}
						<rect
							x={x(index) - barWidth / 2}
							y={DAY - rise(point.volume)}
							width={barWidth}
							height={rise(point.volume)}
							style:fill={CHART_COLORS.volume}
							opacity={dim ? 0.4 : 1}
						/>
					{/if}
					{#if point.quality !== null}
						<rect
							x={x(index) - barWidth / 2}
							y={DAY}
							width={barWidth}
							height={drop(point.quality)}
							style:fill={CHART_COLORS.quality}
							opacity={dim ? 0.35 : 0.85}
						/>
					{/if}
				{/each}

				{#if average !== null}
					<line
						x1={LEFT}
						x2={width - RIGHT}
						y1={nightY(average)}
						y2={nightY(average)}
						class="stroke-moon"
						stroke-width="1"
					/>
					<text
						x={width - RIGHT}
						y={nightY(average) + 15}
						text-anchor="end"
						class="fill-moon text-xs">{m.chart_average_short({ value: Math.round(average) })}</text
					>
				{/if}
				<path
					d={trendPath}
					fill="none"
					class="stroke-moon"
					stroke-width="2.5"
					stroke-linecap="round"
				/>

				<!-- The horizon. -->
				<line x1={0} x2={width} y1={DAY} y2={DAY} class="stroke-ink" stroke-width="1.5" />

				{#each xTicks as tick (tick.point.from)}
					<text x={x(tick.index)} y={HEIGHT - 9} text-anchor="middle" class="fill-moon-2 text-xs"
						>{tickLabel(tick.point)}</text
					>
				{/each}
			{/if}
		</svg>

		{#if activePoint}
			<!-- The readout straddles the horizon too: the day above, that night below. -->
			<div
				class="pointer-events-none absolute z-10 w-[200px] overflow-hidden rounded-(--radius-control) text-sm shadow-lift"
				style:left="{readoutLeft}px"
				style:top="{DAY - 82}px"
			>
				<div class="bg-day px-3 pt-2.5 pb-2">
					<p class="mb-1 font-medium">{pointLabel(activePoint)}</p>
					<dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
						<dt class="flex items-center gap-1.5 text-ink-3">
							<span class="size-2" style:background={CHART_COLORS.volume}></span>
							{m.chart_workouts()}
						</dt>
						<dd class="text-right">{activePoint.workouts}</dd>
						<dt class="pl-3.5 text-ink-3">{m.chart_volume_short()}</dt>
						<dd class="text-right">{formatNumber(activePoint.volume)} kg</dd>
					</dl>
				</div>
				<div class="bg-night-2 px-3 pt-2 pb-2.5 text-moon">
					<dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
						<dt class="flex items-center gap-1.5 text-moon-2">
							<span class="size-2" style:background={CHART_COLORS.quality}></span>
							{m.quality()}
						</dt>
						<dd class="text-right">
							{activePoint.quality === null
								? m.chart_not_tracked()
								: `${Math.round(activePoint.quality)}%`}
						</dd>
						<dt class="pl-3.5 text-moon-2">{trendLabel}</dt>
						<dd class="text-right">
							{activePoint.trend === null
								? m.chart_not_tracked()
								: `${Math.round(activePoint.trend)}%`}
						</dd>
						<dt class="pl-3.5 text-moon-2">{m.chart_asleep()}</dt>
						<dd class="text-right">
							{activePoint.asleep === null
								? m.chart_not_tracked()
								: formatHours(activePoint.asleep)}
						</dd>
					</dl>
				</div>
			</div>
		{/if}
	</div>
</div>
