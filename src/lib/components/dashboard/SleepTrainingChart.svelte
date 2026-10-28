<script lang="ts">
	import { curveMonotoneX, line } from 'd3-shape';
	import { CHART_COLORS } from '#lib/charts.js';
	import { dayToDate } from '#lib/days.js';
	import { formatCompact, formatDate, formatHours, formatNumber } from '#lib/format.js';
	import { TREND_DAYS, type ChartPoint, type Granularity } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';

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

	const HEIGHT = 300;
	const LEFT = 40;
	const RIGHT = 12;
	const TOP = 10;
	const QUALITY_BOTTOM = 190;
	const BAND_TOP = 212;
	const BAND_BOTTOM = 272;
	const TOOLTIP_WIDTH = 176;

	let width = $state(0);
	let active = $state<number | null>(null);

	const innerWidth = $derived(Math.max(0, width - LEFT - RIGHT));
	const step = $derived(points.length === 0 ? 0 : innerWidth / points.length);
	const x = (index: number) => LEFT + (index + 0.5) * step;

	// Fitted to the data in steps of ten, so ordinary variation stays visible.
	const domain = $derived.by((): [number, number] => {
		const values = points.flatMap((point) => (point.quality === null ? [] : [point.quality]));
		if (values.length === 0) return [0, 100];
		const low = Math.max(0, Math.floor((Math.min(...values) - 5) / 10) * 10);
		const high = Math.min(100, Math.ceil((Math.max(...values) + 5) / 10) * 10);
		return [Math.min(low, high - 20), Math.max(high, low + 20)];
	});
	const y = (value: number) =>
		TOP + (1 - (value - domain[0]) / (domain[1] - domain[0])) * (QUALITY_BOTTOM - TOP);
	const yTicks = $derived.by(() => {
		const stride = domain[1] - domain[0] > 40 ? 20 : 10;
		const ticks: number[] = [];
		for (let tick = domain[0]; tick <= domain[1]; tick += stride) ticks.push(tick);
		return ticks;
	});

	const maxVolume = $derived(Math.max(1, ...points.map((point) => point.volume)));
	const barHeight = (volume: number) => (volume / maxVolume) * (BAND_BOTTOM - BAND_TOP);
	const barWidth = $derived(Math.max(1, Math.min(16, step * 0.6)));
	const dotRadius = $derived(Math.max(1.5, Math.min(3.5, step * 0.3)));

	const trendPath = $derived(
		line<ChartPoint>()
			.defined((point) => point.trend !== null)
			.x((_, index) => x(index))
			.y((point) => y(point.trend ?? 0))
			.curve(curveMonotoneX)(points) ?? ''
	);

	const xTicks = $derived.by(() => {
		const count = Math.max(2, Math.floor(innerWidth / (granularity === 'day' ? 90 : 110)));
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
	// Beside the crosshair, on whichever side has room, so it never hides the inspected point.
	const tooltipLeft = $derived.by(() => {
		if (active === null) return 0;
		const right = x(active) + 12;
		return right + TOOLTIP_WIDTH <= width ? right : Math.max(0, x(active) - 12 - TOOLTIP_WIDTH);
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

<!-- A slider over the points, so keyboard and screen reader users can inspect them too. -->
<div
	class="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
	{#if width > 0}
		<svg
			{width}
			height={HEIGHT}
			class="block touch-pan-y select-none"
			aria-hidden="true"
			onpointermove={(event) => pick(event.clientX, event.currentTarget)}
			onpointerdown={(event) => pick(event.clientX, event.currentTarget)}
			onpointerleave={() => (active = null)}
		>
			{#each yTicks as tick (tick)}
				<line x1={LEFT} x2={width - RIGHT} y1={y(tick)} y2={y(tick)} class="stroke-border" />
				<text
					x={LEFT - 8}
					y={y(tick)}
					dy="0.32em"
					text-anchor="end"
					class="fill-muted-foreground text-[10px] tabular-nums">{tick}%</text
				>
			{/each}
			<text
				x={LEFT - 8}
				y={BAND_TOP + 4}
				text-anchor="end"
				class="fill-muted-foreground text-[10px]">{formatCompact(Math.round(maxVolume))}</text
			>
			<text x={LEFT - 8} y={BAND_BOTTOM} text-anchor="end" class="fill-muted-foreground text-[10px]"
				>kg</text
			>
			<line x1={LEFT} x2={width - RIGHT} y1={BAND_BOTTOM} y2={BAND_BOTTOM} class="stroke-border" />

			{#if active !== null}
				<rect
					x={x(active) - step / 2}
					y={TOP}
					width={step}
					height={BAND_BOTTOM - TOP}
					class="fill-foreground/5"
				/>
			{/if}

			{#each points as point, index (point.from)}
				{#if point.volume > 0}
					<rect
						x={x(index) - barWidth / 2}
						y={BAND_BOTTOM - barHeight(point.volume)}
						width={barWidth}
						height={barHeight(point.volume)}
						rx="1.5"
						fill={CHART_COLORS.volume}
						opacity={active === null || active === index ? 0.9 : 0.45}
					/>
				{/if}
				{#if point.quality !== null}
					<circle
						cx={x(index)}
						cy={y(point.quality)}
						r={active === index ? dotRadius + 1.5 : dotRadius}
						fill={CHART_COLORS.quality}
						opacity={active === index ? 1 : 0.5}
					/>
				{/if}
			{/each}

			{#if average !== null}
				<line
					x1={LEFT}
					x2={width - RIGHT}
					y1={y(average)}
					y2={y(average)}
					class="stroke-foreground/50"
					stroke-dasharray="4 4"
				/>
				<text
					x={width - RIGHT}
					y={y(average) - 5}
					text-anchor="end"
					class="fill-muted-foreground text-[10px] tabular-nums"
					>{m.chart_average_short({ value: Math.round(average) })}</text
				>
			{/if}
			<path
				d={trendPath}
				fill="none"
				stroke={CHART_COLORS.quality}
				stroke-width="2.5"
				stroke-linecap="round"
			/>

			{#if active !== null}
				<line
					x1={x(active)}
					x2={x(active)}
					y1={TOP}
					y2={BAND_BOTTOM}
					class="stroke-foreground/40"
				/>
			{/if}

			{#each xTicks as tick (tick.point.from)}
				<text
					x={x(tick.index)}
					y={HEIGHT - 8}
					text-anchor="middle"
					class="fill-muted-foreground text-[10px]">{tickLabel(tick.point)}</text
				>
			{/each}
		</svg>
	{/if}

	{#if activePoint}
		<div
			class="pointer-events-none absolute top-2 z-10 w-44 rounded-md border bg-popover p-2.5 text-xs text-popover-foreground shadow-lg"
			style:left="{tooltipLeft}px"
		>
			<p class="mb-1.5 font-medium">{pointLabel(activePoint)}</p>
			<dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
				<dt class="flex items-center gap-1.5 text-muted-foreground">
					<span class="size-2 rounded-full" style:background={CHART_COLORS.quality}></span>
					{m.quality()}
				</dt>
				<dd class="text-right font-medium">
					{activePoint.quality === null
						? m.chart_not_tracked()
						: `${Math.round(activePoint.quality)}%`}
				</dd>
				<dt class="pl-3.5 text-muted-foreground">{trendLabel}</dt>
				<dd class="text-right">
					{activePoint.trend === null ? '—' : `${Math.round(activePoint.trend)}%`}
				</dd>
				<dt class="pl-3.5 text-muted-foreground">{m.chart_asleep()}</dt>
				<dd class="text-right">
					{activePoint.asleep === null ? '—' : formatHours(activePoint.asleep)}
				</dd>
				<dt class="flex items-center gap-1.5 text-muted-foreground">
					<span class="size-2 rounded-sm" style:background={CHART_COLORS.volume}></span>
					{m.chart_workouts()}
				</dt>
				<dd class="text-right">{activePoint.workouts}</dd>
				<dt class="pl-3.5 text-muted-foreground">{m.chart_volume_short()}</dt>
				<dd class="text-right">{formatNumber(activePoint.volume)} kg</dd>
			</dl>
		</div>
	{/if}
</div>
