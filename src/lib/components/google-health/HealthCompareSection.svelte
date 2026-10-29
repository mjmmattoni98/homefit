<script lang="ts">
	import Measure from '#lib/components/Measure.svelte';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { dayToDate } from '#lib/days.js';
	import { formatDate, formatNumber, formatSigned } from '#lib/format.js';
	import { metricLabel } from '#lib/google-health/labels.js';
	import {
		formatMetricNumber,
		summaryNumber,
		type HealthMetric,
		type HealthSummary
	} from '#lib/google-health/view.js';
	import { compareHealthMetrics } from '#lib/health-correlation.js';
	import * as m from '#lib/paraglide/messages.js';

	type MetricWithTrend = HealthMetric & { trend: HealthSummary[] };

	let {
		metrics,
		days = 30
	}: {
		metrics: MetricWithTrend[];
		days?: number;
	} = $props();

	const numericMetrics = $derived(
		metrics.filter((metric) => metric.trend.some((s) => summaryNumber(metric, s) !== null))
	);

	let leftKey = $state<string | null>(null);
	let rightKey = $state<string | null>(null);
	let lagDays = $state<0 | 1>(0);
	let width = $state(0);
	let active = $state<number | null>(null);

	const leftMetric = $derived.by(() => {
		if (leftKey) {
			const found = numericMetrics.find((mItem) => mItem.dataType === leftKey);
			if (found) return found;
		}
		return numericMetrics[0];
	});

	const rightMetric = $derived.by(() => {
		if (rightKey && rightKey !== leftMetric?.dataType) {
			const found = numericMetrics.find((mItem) => mItem.dataType === rightKey);
			if (found) return found;
		}
		return (
			numericMetrics.find((mItem) => mItem.dataType !== leftMetric?.dataType) ?? numericMetrics[1]
		);
	});

	const comparison = $derived(
		leftMetric && rightMetric
			? compareHealthMetrics(leftMetric, leftMetric.trend, rightMetric, rightMetric.trend, lagDays)
			: null
	);

	const points = $derived(comparison?.points ?? []);
	const CHART_HEIGHT = 196;
	const LABELS = 28;
	const HEIGHT = CHART_HEIGHT + LABELS;
	const LEFT = 12;
	const RIGHT = 12;
	const TOP = 12;
	const BOTTOM_INSET = 10;
	const READOUT_WIDTH = 228;

	const innerWidth = $derived(Math.max(0, width - LEFT - RIGHT));
	const plotHeight = CHART_HEIGHT - TOP - BOTTOM_INSET;
	const step = $derived(points.length === 0 ? 0 : innerWidth / points.length);
	const x = (index: number) => LEFT + (index + 0.5) * step;
	const y = (norm: number) => TOP + plotHeight * (1 - Math.min(1, Math.max(0, norm)));

	const leftPath = $derived(
		points
			.flatMap((p, index) =>
				p.leftNorm === null ? [] : [`${x(index).toFixed(1)},${y(p.leftNorm).toFixed(1)}`]
			)
			.map((coord, i) => `${i === 0 ? 'M' : 'L'}${coord}`)
			.join(' ')
	);
	const rightPath = $derived(
		points
			.flatMap((p, index) =>
				p.rightNorm === null ? [] : [`${x(index).toFixed(1)},${y(p.rightNorm).toFixed(1)}`]
			)
			.map((coord, i) => `${i === 0 ? 'M' : 'L'}${coord}`)
			.join(' ')
	);

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

	function formatDisplay(metric: HealthMetric, val: number | null): string {
		if (val === null) return m.chart_not_tracked();
		if (metric.aggregation === 'duration') return `${formatNumber(val, 1)} h`;
		return formatMetricNumber(val, metric.primaryUnit);
	}

	function formatDiff(metric: HealthMetric, diff: number | null): string {
		if (diff === null) return '—';
		const unit = metric.aggregation === 'duration' ? 'h' : (metric.primaryUnit ?? '');
		const digits = Math.abs(diff) < 10 ? 1 : 0;
		return unit ? `${formatSigned(diff, digits)} ${unit}` : formatSigned(diff, digits);
	}

	function pick(clientX: number, target: SVGSVGElement): void {
		if (points.length === 0) return;
		const offset = clientX - target.getBoundingClientRect().left - LEFT;
		active = Math.min(points.length - 1, Math.max(0, Math.floor(offset / step)));
	}
</script>

{#if numericMetrics.length >= 2 && leftMetric && rightMetric && comparison}
	<section class="mt-16 border-t border-ink pt-10" aria-labelledby="health-compare-title">
		<div class="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
			<div class="min-w-0">
				<h2 id="health-compare-title" class="text-2xl">{m.health_compare_title()}</h2>
				<p class="mt-2 max-w-[62ch] text-sm text-ink-3">{m.health_compare_desc({ days })}</p>
			</div>

			<div class="flex flex-wrap items-end gap-3">
				<label class="flex flex-col gap-1 text-xs text-ink-3">
					<span>{m.health_compare_first()}</span>
					<select
						class="h-9 border border-rule bg-day px-2.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus"
						value={leftMetric.dataType}
						onchange={(e) => {
							const next = e.currentTarget.value;
							if (next === rightMetric.dataType) rightKey = leftMetric.dataType;
							leftKey = next;
						}}
					>
						{#each numericMetrics as opt (opt.dataType)}
							<option value={opt.dataType}>{metricLabel(opt.dataType)}</option>
						{/each}
					</select>
				</label>

				<label class="flex flex-col gap-1 text-xs text-ink-3">
					<span>{m.health_compare_second()}</span>
					<select
						class="h-9 border border-rule bg-day px-2.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-focus"
						value={rightMetric.dataType}
						onchange={(e) => {
							const next = e.currentTarget.value;
							if (next === leftMetric.dataType) leftKey = rightMetric.dataType;
							rightKey = next;
						}}
					>
						{#each numericMetrics as opt (opt.dataType)}
							<option value={opt.dataType}>{metricLabel(opt.dataType)}</option>
						{/each}
					</select>
				</label>

				<ToggleGroup.Root
					type="single"
					bind:value={
						() => String(lagDays),
						(next) => {
							if (next === '0' || next === '1') lagDays = Number(next) as 0 | 1;
						}
					}
					variant="outline"
					aria-label={m.health_compare_title()}
					class="data-[variant=outline]:shadow-none"
				>
					<ToggleGroup.Item value="0" class="h-9 px-2.5 text-xs">
						{m.health_compare_same_day()}
					</ToggleGroup.Item>
					<ToggleGroup.Item value="1" class="h-9 px-2.5 text-xs">
						{m.health_compare_next_day()}
					</ToggleGroup.Item>
				</ToggleGroup.Root>
			</div>
		</div>

		<dl class="mt-7 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 sm:gap-x-12">
			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-ink-3">{m.health_compare_paired()}</dt>
				<dd>
					<Measure
						value={formatNumber(comparison.pairedDays)}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
					/>
				</dd>
			</div>

			<div class="flex min-w-0 flex-col gap-1">
				<dt class="text-sm text-ink-3">{m.health_compare_correlation()}</dt>
				<dd>
					<Measure
						value={comparison.correlation === null ? '—' : formatSigned(comparison.correlation, 2)}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
					/>
				</dd>
				{#if comparison.correlation === null}
					<dd class="text-sm text-ink-3">{m.health_compare_insufficient()}</dd>
				{/if}
			</div>

			<div class="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1">
				<dt class="truncate text-sm text-ink-3">
					{m.health_compare_split({ metric: metricLabel(leftMetric.dataType) })}
				</dt>
				<dd>
					<Measure
						value={formatDiff(rightMetric, comparison.highVsLowDiff)}
						class="text-3xl font-figure sm:text-4xl"
						unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
					/>
				</dd>
				<dd class="truncate text-sm text-ink-3">{metricLabel(rightMetric.dataType)}</dd>
			</div>
		</dl>

		{#if points.length > 0}
			<div class="mt-7">
				<ul class="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-2">
					<li class="flex items-center gap-2">
						<span class="h-0.5 w-4 bg-sun" aria-hidden="true"></span>
						{metricLabel(leftMetric.dataType)}
					</li>
					<li class="flex items-center gap-2">
						<span class="h-0.5 w-4 bg-sleep" aria-hidden="true"></span>
						{metricLabel(rightMetric.dataType)}
					</li>
				</ul>

				<div class="relative" bind:clientWidth={width}>
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
							{#each [0, 0.5, 1] as level (level)}
								<line
									x1={LEFT}
									x2={width - RIGHT}
									y1={y(level)}
									y2={y(level)}
									class="stroke-rule"
								/>
							{/each}

							{#if active !== null}
								<rect
									x={x(active) - step / 2}
									y={TOP}
									width={step}
									height={plotHeight}
									class="fill-ink/5"
								/>
							{/if}

							{#if leftPath}
								<path
									d={leftPath}
									fill="none"
									class="stroke-sun"
									stroke-width="2"
									stroke-linejoin="round"
									stroke-linecap="round"
								/>
							{/if}
							{#if rightPath}
								<path
									d={rightPath}
									fill="none"
									class="stroke-sleep"
									stroke-width="2"
									stroke-linejoin="round"
									stroke-linecap="round"
								/>
							{/if}

							{#each points as point, index (point.date)}
								{#if point.leftNorm !== null}
									<circle
										cx={x(index)}
										cy={y(point.leftNorm)}
										r={active === index ? 4 : 2.5}
										class="fill-sun stroke-day"
										stroke-width="1"
									/>
								{/if}
								{#if point.rightNorm !== null}
									<circle
										cx={x(index)}
										cy={y(point.rightNorm)}
										r={active === index ? 4 : 2.5}
										class="fill-sleep stroke-day"
										stroke-width="1"
									/>
								{/if}
							{/each}

							{#each xTicks as tick (tick.point.date)}
								<text
									x={x(tick.index)}
									y={HEIGHT - 8}
									text-anchor="middle"
									class="fill-ink-3 text-xs"
								>
									{formatDate(dayToDate(tick.point.date).getTime())}
								</text>
							{/each}
						{/if}
					</svg>

					{#if activePoint !== null}
						<div
							class="pointer-events-none absolute top-3 z-10 w-[228px] border border-rule bg-day px-3 py-2.5 text-xs text-ink shadow-lift"
							style:left="{readoutLeft}px"
						>
							<p class="font-medium">
								{formatDate(dayToDate(activePoint.date).getTime(), {
									weekday: 'short',
									day: 'numeric',
									month: 'short'
								})}
							</p>
							<dl class="mt-1.5 space-y-1">
								<div class="flex justify-between gap-2">
									<dt class="flex items-center gap-1.5 truncate text-ink-2">
										<span class="size-2 shrink-0 bg-sun"></span>
										<span class="truncate">{metricLabel(leftMetric.dataType)}</span>
									</dt>
									<dd class="shrink-0 font-medium">
										{formatDisplay(leftMetric, activePoint.left)}
									</dd>
								</div>
								<div class="flex justify-between gap-2">
									<dt class="flex items-center gap-1.5 truncate text-ink-2">
										<span class="size-2 shrink-0 bg-sleep"></span>
										<span class="truncate">{metricLabel(rightMetric.dataType)}</span>
									</dt>
									<dd class="shrink-0 font-medium">
										{formatDisplay(rightMetric, activePoint.right)}
									</dd>
								</div>
							</dl>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</section>
{/if}
