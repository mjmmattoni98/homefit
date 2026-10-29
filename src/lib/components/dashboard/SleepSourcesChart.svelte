<script lang="ts">
	import Measure from '#lib/components/Measure.svelte';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { dayToDate } from '#lib/days.js';
	import { formatDate, formatHours, formatNumber, formatSigned } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import {
		formatEveningMinute,
		type PairedSleepNight,
		type SleepSourceMetric,
		type SleepSourcesSummary
	} from '#lib/sleep-sources.js';
	import { cn } from '#lib/utils.js';

	let {
		comparison,
		embedded = false
	}: {
		comparison: SleepSourcesSummary;
		/** True when rendered inside an existing night band (`bleed bg-night`). */
		embedded?: boolean;
	} = $props();

	const METRICS: { key: SleepSourceMetric; label: () => string }[] = [
		{ key: 'asleep', label: () => m.sleep_sources_metric_asleep() },
		{ key: 'inBed', label: () => m.sleep_sources_metric_in_bed() },
		{ key: 'efficiency', label: () => m.sleep_sources_metric_efficiency() },
		{ key: 'timing', label: () => m.sleep_sources_metric_timing() }
	];

	let metric = $state<SleepSourceMetric>('asleep');
	let width = $state(0);
	let active = $state<number | null>(null);

	const points = $derived(comparison.points);
	const CHART_HEIGHT = 228;
	const LABELS = 28;
	const HEIGHT = CHART_HEIGHT + LABELS;
	const LEFT = 48;
	const RIGHT = 12;
	const TOP = 14;
	const READOUT_WIDTH = 224;

	const innerWidth = $derived(Math.max(0, width - LEFT - RIGHT));
	const innerHeight = CHART_HEIGHT - TOP;
	const step = $derived(points.length === 0 ? 0 : innerWidth / points.length);
	const x = (index: number) => LEFT + (index + 0.5) * step;
	const pairHalf = $derived(Math.max(1, Math.min(7, step * 0.24)));
	const barW = $derived(Math.max(1.5, Math.min(10, step * 0.28)));

	// Duration scale (hours) for 'asleep' & 'inBed'
	const maxHours = $derived.by(() => {
		let maxMin = 8 * 60;
		for (const p of points) {
			if (metric === 'asleep') {
				maxMin = Math.max(maxMin, p.sleepCycleAsleepMin ?? 0, p.googleAsleepMin ?? 0);
			} else if (metric === 'inBed') {
				maxMin = Math.max(maxMin, p.sleepCycleInBedMin ?? 0, p.googleInBedMin ?? 0);
			}
		}
		return Math.max(8, Math.ceil(maxMin / 120) * 2);
	});

	// Timing scale (evening offset minutes from 18:00, e.g. 21:00 = 180 .. 11:00 = 1020)
	const timingBounds = $derived.by(() => {
		let min = 22 * 60 - 18 * 60; // 22:00 (240)
		let max = (24 + 9 - 18) * 60; // 09:00 (900)
		for (const p of points) {
			for (const bed of [p.sleepCycleBedMinute, p.googleBedMinute]) {
				if (bed !== null) min = Math.min(min, bed);
			}
			for (const wake of [p.sleepCycleWakeMinute, p.googleWakeMinute]) {
				if (wake !== null) max = Math.max(max, wake);
			}
		}
		const floorHour = Math.floor(min / 60) * 60;
		const ceilHour = Math.ceil(max / 60) * 60;
		return { min: floorHour, max: Math.max(floorHour + 360, ceilHour) };
	});

	const yMinutes = (mins: number) =>
		TOP + innerHeight * (1 - Math.min(1, Math.max(0, mins / (maxHours * 60))));
	const yPercent = (pct: number) =>
		TOP + innerHeight * (1 - Math.min(1, Math.max(0, (pct - 40) / 60)));
	const yTiming = (offsetMin: number) =>
		TOP +
		innerHeight *
			Math.min(
				1,
				Math.max(0, (offsetMin - timingBounds.min) / (timingBounds.max - timingBounds.min))
			);

	const yTicks = $derived.by(() => {
		if (metric === 'efficiency') {
			return [50, 75, 100].map((v) => ({ y: yPercent(v), label: `${v}%` }));
		}
		if (metric === 'timing') {
			const spanHours = (timingBounds.max - timingBounds.min) / 60;
			const hourStep = spanHours > 12 ? 4 : 3;
			const ticks: { y: number; label: string }[] = [];
			for (let mOff = timingBounds.min; mOff <= timingBounds.max; mOff += hourStep * 60) {
				ticks.push({ y: yTiming(mOff), label: formatEveningMinute(mOff) });
			}
			return ticks;
		}
		const half = maxHours / 2;
		return [0, half, maxHours].map((h) => ({
			y: yMinutes(h * 60),
			label: h === 0 ? '0' : `${h}h`
		}));
	});

	const xTicks = $derived.by(() => {
		const count = Math.max(2, Math.floor(innerWidth / 96));
		const stride = Math.max(1, Math.ceil(points.length / count));
		return points.flatMap((point, index) => (index % stride === 0 ? [{ point, index }] : []));
	});

	const activePoint = $derived(active === null ? null : points[active]);
	const readoutLeft = $derived.by(() => {
		if (active === null) return 0;
		const right = x(active) + step / 2 + 10;
		return right + READOUT_WIDTH <= width
			? right
			: Math.max(0, x(active) - step / 2 - 10 - READOUT_WIDTH);
	});

	function formatOffsetHint(offset: number | null): string {
		if (offset === null) return '';
		const rounded = Math.round(offset);
		if (rounded === 0) return m.sleep_sources_offset_same();
		return rounded < 0
			? m.sleep_sources_offset_earlier({ minutes: formatNumber(Math.abs(rounded)) })
			: m.sleep_sources_offset_later({ minutes: formatNumber(rounded) });
	}

	function pointDeltaText(p: PairedSleepNight): string | null {
		if (metric === 'asleep' && p.sleepCycleAsleepMin !== null && p.googleAsleepMin !== null) {
			return `${formatSigned(p.sleepCycleAsleepMin - p.googleAsleepMin, 0)} min`;
		}
		if (metric === 'inBed' && p.sleepCycleInBedMin !== null && p.googleInBedMin !== null) {
			return `${formatSigned(p.sleepCycleInBedMin - p.googleInBedMin, 0)} min`;
		}
		if (metric === 'efficiency' && p.sleepCycleEfficiency !== null && p.googleEfficiency !== null) {
			return m.points_short({
				value: formatSigned(p.sleepCycleEfficiency - p.googleEfficiency, 1)
			});
		}
		if (metric === 'timing' && p.sleepCycleBedMinute !== null && p.googleBedMinute !== null) {
			return `${formatSigned(p.sleepCycleBedMinute - p.googleBedMinute, 0)} min`;
		}
		return null;
	}

	function sourceValueText(side: 'sc' | 'gh', p: PairedSleepNight): string {
		if (side === 'sc') {
			if (!p.sleepCycle) return m.chart_not_tracked();
			if (metric === 'asleep') {
				return p.sleepCycleAsleepMin !== null
					? formatHours(p.sleepCycleAsleepMin * 60)
					: m.chart_not_tracked();
			}
			if (metric === 'inBed') {
				return p.sleepCycleInBedMin !== null
					? formatHours(p.sleepCycleInBedMin * 60)
					: m.chart_not_tracked();
			}
			if (metric === 'efficiency') {
				return p.sleepCycleEfficiency !== null
					? `${Math.round(p.sleepCycleEfficiency)}%`
					: m.chart_not_tracked();
			}
			const bed = p.sleepCycleBedMinute !== null ? formatEveningMinute(p.sleepCycleBedMinute) : '—';
			const wake =
				p.sleepCycleWakeMinute !== null ? formatEveningMinute(p.sleepCycleWakeMinute) : '—';
			return `${bed} to ${wake}`;
		}
		if (!p.googleHealth) return m.chart_not_tracked();
		if (metric === 'asleep') {
			return p.googleAsleepMin !== null
				? formatHours(p.googleAsleepMin * 60)
				: m.chart_not_tracked();
		}
		if (metric === 'inBed') {
			return p.googleInBedMin !== null ? formatHours(p.googleInBedMin * 60) : m.chart_not_tracked();
		}
		if (metric === 'efficiency') {
			return p.googleEfficiency !== null
				? `${Math.round(p.googleEfficiency)}%`
				: m.chart_not_tracked();
		}
		const bed = p.googleBedMinute !== null ? formatEveningMinute(p.googleBedMinute) : '—';
		const wake = p.googleWakeMinute !== null ? formatEveningMinute(p.googleWakeMinute) : '—';
		return `${bed} to ${wake}`;
	}

	const valueText = $derived.by(() => {
		const p = points[active ?? points.length - 1];
		if (!p) return '';
		const date = formatDate(dayToDate(p.night).getTime(), {
			weekday: 'short',
			day: 'numeric',
			month: 'short'
		});
		return `${date}: ${m.sleep_sources_legend_sc()} ${sourceValueText('sc', p)}, ${m.sleep_sources_legend_gh()} ${sourceValueText('gh', p)}`;
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

	const stageTotal = $derived(
		comparison.googleStages
			? comparison.googleStages.deepMin +
					comparison.googleStages.lightMin +
					comparison.googleStages.remMin +
					comparison.googleStages.awakeMin
			: 0
	);
</script>

<section
	class={cn(
		'min-w-0 text-moon',
		embedded ? 'border-t border-night-rule pt-10 pb-10' : 'bg-night px-5 pt-7 pb-6 sm:px-7'
	)}
	aria-labelledby="sleep-sources-title"
>
	<div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
		<div class="min-w-0">
			<h2 id="sleep-sources-title" class="text-2xl">{m.sleep_sources_title()}</h2>
			<p class="mt-2 max-w-[62ch] text-sm text-moon-2">{m.sleep_sources_desc()}</p>
		</div>
		<ToggleGroup.Root
			type="single"
			bind:value={
				() => metric,
				(next) => {
					if (next) metric = next as SleepSourceMetric;
				}
			}
			variant="outline"
			aria-label={m.sleep_sources_title()}
			class="w-full border-night-rule data-[variant=outline]:shadow-none sm:w-auto"
		>
			{#each METRICS as option (option.key)}
				<ToggleGroup.Item
					value={option.key}
					class="h-9 flex-1 border-night-rule px-2.5 text-sm text-moon-2 hover:bg-night-2 hover:text-moon data-[state=on]:bg-night-2 data-[state=on]:text-moon sm:flex-none"
				>
					{option.label()}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	</div>

	{#if comparison.sharedNights > 0}
		<dl class="mt-7 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4 sm:gap-x-10">
			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-moon-2">{m.sleep_sources_shared_nights()}</dt>
				<dd>
					<Measure
						value={formatNumber(comparison.sharedNights)}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
					/>
				</dd>
				<dd class="text-sm text-moon-2">
					{m.sleep_sources_shared_hint({
						scOnly: comparison.sleepCycleOnlyNights,
						ghOnly: comparison.googleOnlyNights
					})}
				</dd>
			</div>

			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-moon-2">{m.sleep_sources_asleep_diff()}</dt>
				<dd>
					<Measure
						value={comparison.asleepDeltaMin === null
							? '—'
							: `${formatSigned(comparison.asleepDeltaMin, 0)} min`}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
					/>
				</dd>
				{#if comparison.asleepMeanAbsDiffMin !== null}
					<dd class="text-sm text-moon-2">
						{m.sleep_sources_asleep_diff_hint({
							abs: formatNumber(Math.round(comparison.asleepMeanAbsDiffMin))
						})}
					</dd>
				{/if}
			</div>

			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-moon-2">{m.sleep_sources_bedtime_offset()}</dt>
				<dd>
					<Measure
						value={comparison.bedtimeOffsetMin === null
							? '—'
							: `${formatSigned(comparison.bedtimeOffsetMin, 0)} min`}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
					/>
				</dd>
				{#if comparison.bedtimeOffsetMin !== null}
					<dd class="text-sm text-moon-2">{formatOffsetHint(comparison.bedtimeOffsetMin)}</dd>
				{/if}
			</div>

			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-moon-2">{m.sleep_sources_wake_offset()}</dt>
				<dd>
					<Measure
						value={comparison.wakeOffsetMin === null
							? '—'
							: `${formatSigned(comparison.wakeOffsetMin, 0)} min`}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-moon-2"
					/>
				</dd>
				{#if comparison.wakeOffsetMin !== null}
					<dd class="text-sm text-moon-2">{formatOffsetHint(comparison.wakeOffsetMin)}</dd>
				{/if}
			</div>
		</dl>
	{:else}
		<p class="mt-6 text-sm text-moon-2">{m.sleep_sources_no_overlap()}</p>
	{/if}

	{#if points.length > 0}
		<div class="mt-7">
			<ul class="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-moon-2">
				<li class="flex items-center gap-2">
					<span class="size-2.5 bg-sleep" aria-hidden="true"></span>
					{m.sleep_sources_legend_sc()}
					{#if comparison.meanSleepCycleAsleepMin !== null && metric === 'asleep'}
						<span class="text-moon">({formatHours(comparison.meanSleepCycleAsleepMin * 60)})</span>
					{/if}
				</li>
				<li class="flex items-center gap-2">
					<span class="size-2.5 border border-moon bg-moon/85" aria-hidden="true"></span>
					{m.sleep_sources_legend_gh()}
					{#if comparison.meanGoogleAsleepMin !== null && metric === 'asleep'}
						<span class="text-moon">({formatHours(comparison.meanGoogleAsleepMin * 60)})</span>
					{/if}
				</li>
			</ul>

			<div
				class="relative focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
				bind:clientWidth={width}
				role="slider"
				aria-label={m.sleep_sources_chart_label()}
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
							{@const dim = active !== null && active !== index}

							{#if metric === 'timing'}
								{#if point.sleepCycleBedMinute !== null && point.sleepCycleWakeMinute !== null}
									{@const y1 = yTiming(point.sleepCycleBedMinute)}
									{@const y2 = yTiming(point.sleepCycleWakeMinute)}
									<rect
										x={cx - pairHalf - barW / 2}
										y={Math.min(y1, y2)}
										width={barW}
										height={Math.max(2, Math.abs(y2 - y1))}
										class="fill-sleep"
										opacity={dim ? 0.35 : 0.9}
									/>
								{/if}
								{#if point.googleBedMinute !== null && point.googleWakeMinute !== null}
									{@const y1 = yTiming(point.googleBedMinute)}
									{@const y2 = yTiming(point.googleWakeMinute)}
									<rect
										x={cx + pairHalf - barW / 2}
										y={Math.min(y1, y2)}
										width={barW}
										height={Math.max(2, Math.abs(y2 - y1))}
										class="fill-moon"
										opacity={dim ? 0.35 : 0.85}
									/>
								{/if}
							{:else if metric === 'efficiency'}
								{@const scVal = point.sleepCycleEfficiency}
								{@const ghVal = point.googleEfficiency}
								{#if scVal !== null && ghVal !== null}
									<line
										x1={cx}
										x2={cx}
										y1={yPercent(scVal)}
										y2={yPercent(ghVal)}
										class="stroke-moon-2/60"
										stroke-width="1.5"
										opacity={dim ? 0.35 : 0.9}
									/>
								{/if}
								{#if scVal !== null}
									<circle
										{cx}
										cy={yPercent(scVal)}
										r={3.5}
										class="fill-sleep"
										opacity={dim ? 0.35 : 1}
									/>
								{/if}
								{#if ghVal !== null}
									<circle
										{cx}
										cy={yPercent(ghVal)}
										r={3.5}
										class="fill-moon stroke-night"
										stroke-width="1"
										opacity={dim ? 0.35 : 1}
									/>
								{/if}
							{:else}
								{@const scMin =
									metric === 'asleep' ? point.sleepCycleAsleepMin : point.sleepCycleInBedMin}
								{@const ghMin = metric === 'asleep' ? point.googleAsleepMin : point.googleInBedMin}
								{#if step >= 14}
									{#if scMin !== null}
										{@const topY = yMinutes(scMin)}
										<rect
											x={cx - barW - 0.75}
											y={topY}
											width={barW}
											height={Math.max(1, CHART_HEIGHT - topY)}
											class="fill-sleep"
											opacity={dim ? 0.35 : 0.9}
										/>
									{/if}
									{#if ghMin !== null}
										{@const topY = yMinutes(ghMin)}
										<rect
											x={cx + 0.75}
											y={topY}
											width={barW}
											height={Math.max(1, CHART_HEIGHT - topY)}
											class="fill-moon"
											opacity={dim ? 0.35 : 0.85}
										/>
									{/if}
								{:else}
									{#if scMin !== null && ghMin !== null}
										<line
											x1={cx}
											x2={cx}
											y1={yMinutes(scMin)}
											y2={yMinutes(ghMin)}
											class="stroke-moon-2/60"
											stroke-width="1.5"
											opacity={dim ? 0.35 : 0.85}
										/>
									{/if}
									{#if scMin !== null}
										<circle
											{cx}
											cy={yMinutes(scMin)}
											r={2.75}
											class="fill-sleep"
											opacity={dim ? 0.35 : 1}
										/>
									{/if}
									{#if ghMin !== null}
										<circle
											{cx}
											cy={yMinutes(ghMin)}
											r={2.75}
											class="fill-moon"
											opacity={dim ? 0.35 : 1}
										/>
									{/if}
								{/if}
							{/if}
						{/each}

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
					{@const delta = pointDeltaText(activePoint)}
					<div
						class="pointer-events-none absolute top-3 z-10 w-[224px] border border-night-rule bg-night-2 px-3 py-2.5 text-xs text-moon shadow-lift"
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
								<dt class="flex items-center gap-1.5 text-moon-2">
									<span class="size-2 bg-sleep"></span>
									{m.sleep_sources_legend_sc()}
								</dt>
								<dd class="font-medium">{sourceValueText('sc', activePoint)}</dd>
							</div>
							<div class="flex justify-between gap-2">
								<dt class="flex items-center gap-1.5 text-moon-2">
									<span class="size-2 bg-moon"></span>
									{m.sleep_sources_legend_gh()}
								</dt>
								<dd class="font-medium">{sourceValueText('gh', activePoint)}</dd>
							</div>
							{#if delta !== null}
								<div class="flex justify-between gap-2 border-t border-night-rule pt-1">
									<dt class="text-moon-2">{m.sleep_sources_delta_label()}</dt>
									<dd class="font-medium text-moon">{delta}</dd>
								</div>
							{/if}
						</dl>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if comparison.googleStages !== null && stageTotal > 0}
		{@const s = comparison.googleStages}
		<div class="mt-7 border-t border-night-rule pt-5">
			<p class="text-sm text-moon-2">{m.sleep_sources_stages_title()}</p>
			<div class="mt-2.5 flex h-2.5 w-full overflow-hidden bg-night-rule" aria-hidden="true">
				<span class="bg-moon" style:width="{(s.deepMin / stageTotal) * 100}%"></span>
				<span class="bg-sleep" style:width="{(s.remMin / stageTotal) * 100}%"></span>
				<span class="bg-sleep-dim" style:width="{(s.lightMin / stageTotal) * 100}%"></span>
				<span class="bg-moon-2/40" style:width="{(s.awakeMin / stageTotal) * 100}%"></span>
			</div>
			<dl class="mt-2.5 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
				<div class="flex items-center gap-1.5">
					<span class="size-2 bg-moon" aria-hidden="true"></span>
					<dt class="text-moon-2">{m.sleep_sources_stage_deep()}:</dt>
					<dd class="font-medium">{Math.round(s.deepMin)} min</dd>
				</div>
				<div class="flex items-center gap-1.5">
					<span class="size-2 bg-sleep" aria-hidden="true"></span>
					<dt class="text-moon-2">{m.sleep_sources_stage_rem()}:</dt>
					<dd class="font-medium">{Math.round(s.remMin)} min</dd>
				</div>
				<div class="flex items-center gap-1.5">
					<span class="size-2 bg-sleep-dim" aria-hidden="true"></span>
					<dt class="text-moon-2">{m.sleep_sources_stage_light()}:</dt>
					<dd class="font-medium">{Math.round(s.lightMin)} min</dd>
				</div>
				<div class="flex items-center gap-1.5">
					<span class="size-2 bg-moon-2/40" aria-hidden="true"></span>
					<dt class="text-moon-2">{m.sleep_sources_stage_awake()}:</dt>
					<dd class="font-medium">{Math.round(s.awakeMin)} min</dd>
				</div>
			</dl>
		</div>
	{/if}
</section>
