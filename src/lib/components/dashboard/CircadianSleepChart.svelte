<script lang="ts">
	import Measure from '#lib/components/Measure.svelte';
	import { dayToDate } from '#lib/days.js';
	import { formatDate, formatNumber } from '#lib/format.js';
	import type { CircadianSummary } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatEveningMinute } from '#lib/sleep-sources.js';

	let { circadian }: { circadian: CircadianSummary } = $props();

	let width = $state(0);
	let active = $state<number | null>(null);

	const points = $derived(circadian.points);
	const CHART_HEIGHT = 204;
	const LABELS = 28;
	const HEIGHT = CHART_HEIGHT + LABELS;
	const LEFT = 48;
	const RIGHT = 12;
	const TOP = 12;
	const READOUT_WIDTH = 212;

	const innerWidth = $derived(Math.max(0, width - LEFT - RIGHT));
	const innerHeight = CHART_HEIGHT - TOP;
	const step = $derived(points.length === 0 ? 0 : innerWidth / points.length);
	const x = (index: number) => LEFT + (index + 0.5) * step;
	const barWidth = $derived(Math.max(2, Math.min(14, step * 0.62)));

	const bounds = $derived.by(() => {
		let min = 22 * 60 - 18 * 60; // 22:00
		let max = (24 + 9 - 18) * 60; // 09:00
		for (const p of points) {
			min = Math.min(min, p.bedMinute);
			max = Math.max(max, p.wakeMinute);
		}
		const floorHour = Math.floor(min / 60) * 60;
		const ceilHour = Math.ceil(max / 60) * 60;
		return { min: floorHour, max: Math.max(floorHour + 360, ceilHour) };
	});

	const y = (offsetMin: number) =>
		TOP +
		innerHeight * Math.min(1, Math.max(0, (offsetMin - bounds.min) / (bounds.max - bounds.min)));

	const yTicks = $derived.by(() => {
		const spanHours = (bounds.max - bounds.min) / 60;
		const hourStep = spanHours > 12 ? 4 : 3;
		const ticks: { y: number; label: string }[] = [];
		for (let mOff = bounds.min; mOff <= bounds.max; mOff += hourStep * 60) {
			ticks.push({ y: y(mOff), label: formatEveningMinute(mOff) });
		}
		return ticks;
	});

	const xTicks = $derived.by(() => {
		const count = Math.max(2, Math.floor(innerWidth / 96));
		const stride = Math.max(1, Math.ceil(points.length / count));
		return points.flatMap((point, index) => (index % stride === 0 ? [{ point, index }] : []));
	});

	const midpointPath = $derived(
		points
			.map(
				(p, index) =>
					`${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(p.midpointMinute).toFixed(1)}`
			)
			.join(' ')
	);

	const activePoint = $derived(active === null ? null : points[active]);
	const readoutLeft = $derived.by(() => {
		if (active === null) return 0;
		const right = x(active) + step / 2 + 10;
		return right + READOUT_WIDTH <= width
			? right
			: Math.max(0, x(active) - step / 2 - 10 - READOUT_WIDTH);
	});

	const jetlagHint = $derived.by(() => {
		if (circadian.socialJetlagMin === null) return '';
		const rounded = Math.round(circadian.socialJetlagMin);
		if (Math.abs(rounded) < 5) return m.circadian_jetlag_steady();
		return rounded > 0
			? m.circadian_jetlag_later({ minutes: formatNumber(rounded) })
			: m.circadian_jetlag_earlier({ minutes: formatNumber(Math.abs(rounded)) });
	});

	const valueText = $derived.by(() => {
		const p = points[active ?? points.length - 1];
		if (!p) return '';
		const date = formatDate(dayToDate(p.night).getTime(), {
			weekday: 'short',
			day: 'numeric',
			month: 'short'
		});
		return `${date}: ${formatEveningMinute(p.bedMinute)} to ${formatEveningMinute(p.wakeMinute)}`;
	});

	function pick(clientX: number, target: SVGSVGElement): void {
		if (points.length === 0) return;
		const offset = clientX - target.getBoundingClientRect().left - LEFT;
		active = Math.min(points.length - 1, Math.max(0, Math.floor(offset / step)));
	}

	function onkeydown(event: KeyboardEvent): void {
		const last = points.length - 1;
		if (last < 0) return;
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

<section
	class="min-w-0 border-t border-night-rule pt-10 pb-10 text-moon"
	aria-labelledby="circadian-title"
>
	<h2 id="circadian-title" class="text-2xl">{m.circadian_title()}</h2>
	<p class="mt-2 max-w-[62ch] text-sm text-moon-2">{m.circadian_desc()}</p>

	<dl class="mt-7 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4 sm:gap-x-10">
		<div class="flex min-w-0 flex-col gap-1">
			<dt class="text-sm text-moon-2">{m.circadian_bedtime()}</dt>
			<dd>
				<Measure
					value={circadian.meanBedtime ?? '—'}
					class="text-3xl font-figure sm:text-4xl"
					unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
				/>
			</dd>
			{#if circadian.meanLatencyMin !== null}
				<dd class="text-sm text-moon-2">
					{m.kpi_latency_only({ latency: formatNumber(Math.round(circadian.meanLatencyMin)) })}
				</dd>
			{/if}
		</div>

		<div class="flex min-w-0 flex-col gap-1">
			<dt class="text-sm text-moon-2">{m.circadian_wake()}</dt>
			<dd>
				<Measure
					value={circadian.meanWakeTime ?? '—'}
					class="text-3xl font-figure sm:text-4xl"
					unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
				/>
			</dd>
		</div>

		<div class="flex min-w-0 flex-col gap-1">
			<dt class="text-sm text-moon-2">{m.circadian_regularity()}</dt>
			<dd>
				<Measure
					value={circadian.meanRegularity === null
						? '—'
						: `${Math.round(circadian.meanRegularity)}%`}
					class="text-3xl font-figure sm:text-4xl"
					unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
				/>
			</dd>
		</div>

		<div class="flex min-w-0 flex-col gap-1">
			<dt class="text-sm text-moon-2">{m.circadian_jetlag()}</dt>
			<dd>
				<Measure
					value={circadian.socialJetlagMin === null
						? '—'
						: `${Math.abs(Math.round(circadian.socialJetlagMin))} min`}
					class="text-3xl font-figure sm:text-4xl"
					unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
				/>
			</dd>
			{#if jetlagHint}
				<dd class="text-sm text-moon-2">{jetlagHint}</dd>
			{/if}
		</div>
	</dl>

	{#if points.length > 0}
		<div class="mt-7">
			<ul class="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-moon-2">
				<li class="flex items-center gap-2">
					<span class="size-2.5 bg-sleep-dim/70" aria-hidden="true"></span>
					{m.circadian_latency_legend()}
				</li>
				<li class="flex items-center gap-2">
					<span class="size-2.5 bg-sleep" aria-hidden="true"></span>
					{m.circadian_asleep_legend()}
				</li>
				<li class="flex items-center gap-2">
					<span class="h-[2px] w-4 bg-moon" aria-hidden="true"></span>
					{m.circadian_midpoint_legend()}
				</li>
			</ul>

			<div
				class="relative focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
				bind:clientWidth={width}
				role="slider"
				aria-label={m.circadian_chart_label()}
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
						{#each yTicks as tick (tick.label)}
							<line
								x1={LEFT}
								x2={width - RIGHT}
								y1={tick.y}
								y2={tick.y}
								class="stroke-night-rule"
							/>
							<text
								x={LEFT - 8}
								y={tick.y}
								dy="0.32em"
								text-anchor="end"
								class="fill-moon-2 text-xs"
							>
								{tick.label}
							</text>
						{/each}

						{#if active !== null}
							<rect
								x={x(active) - step / 2}
								y={TOP}
								width={step}
								height={innerHeight}
								class="fill-moon/10"
							/>
						{/if}

						{#each points as point, index (point.night)}
							{@const cx = x(index)}
							{@const yBed = y(point.bedMinute)}
							{@const yAsleep = y(point.asleepMinute)}
							{@const yWake = y(point.wakeMinute)}
							{@const dim = active !== null && active !== index}

							{#if yAsleep > yBed}
								<rect
									x={cx - barWidth / 2}
									y={yBed}
									width={barWidth}
									height={Math.max(1, yAsleep - yBed)}
									class="fill-sleep-dim"
									opacity={dim ? 0.25 : 0.65}
								/>
							{/if}
							<rect
								x={cx - barWidth / 2}
								y={yAsleep}
								width={barWidth}
								height={Math.max(2, yWake - yAsleep)}
								class={point.weekend ? 'fill-moon' : 'fill-sleep'}
								opacity={dim ? 0.35 : point.weekend ? 0.85 : 0.9}
							/>
						{/each}

						{#if midpointPath}
							<path
								d={midpointPath}
								fill="none"
								class="stroke-moon"
								stroke-width="1.5"
								opacity="0.85"
							/>
						{/if}

						{#each xTicks as tick (tick.point.night)}
							<text
								x={x(tick.index)}
								y={HEIGHT - 8}
								text-anchor="middle"
								class="fill-moon-2 text-xs"
							>
								{formatDate(dayToDate(tick.point.night).getTime())}
							</text>
						{/each}
					{/if}
				</svg>

				{#if activePoint !== null}
					{@const latency = Math.round(activePoint.asleepMinute - activePoint.bedMinute)}
					<div
						class="pointer-events-none absolute top-3 z-10 w-[212px] border border-night-rule bg-night-2 px-3 py-2.5 text-xs text-moon shadow-lift"
						style:left="{readoutLeft}px"
					>
						<p class="font-medium">
							{formatDate(dayToDate(activePoint.night).getTime(), {
								weekday: 'short',
								day: 'numeric',
								month: 'short'
							})}
						</p>
						<dl class="mt-1.5 space-y-1">
							<div class="flex justify-between gap-2">
								<dt class="text-moon-2">{m.circadian_bedtime()}</dt>
								<dd class="font-medium">{formatEveningMinute(activePoint.bedMinute)}</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="text-moon-2">{m.circadian_latency_legend()}</dt>
								<dd class="font-medium">{latency} min</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="text-moon-2">{m.circadian_wake()}</dt>
								<dd class="font-medium">{formatEveningMinute(activePoint.wakeMinute)}</dd>
							</div>
						</dl>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</section>
