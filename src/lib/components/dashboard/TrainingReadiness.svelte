<script lang="ts">
	import Measure from '#lib/components/Measure.svelte';
	import { CHART_COLORS } from '#lib/charts.js';
	import { formatNumber, formatSigned } from '#lib/format.js';
	import type {
		SleepReadinessSummary,
		VitalsReadinessSummary,
		WorkoutTimingBucket
	} from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import Sparkline from './Sparkline.svelte';

	let {
		readiness,
		timing,
		vitals
	}: {
		readiness: SleepReadinessSummary | null;
		timing: WorkoutTimingBucket[];
		vitals: VitalsReadinessSummary | null;
	} = $props();

	const hasTiming = $derived(timing.some((b) => b.nights > 0));
	const maxVolume = $derived(
		readiness === null
			? 1
			: Math.max(1, readiness.restedMeanVolume ?? 0, readiness.tiredMeanVolume ?? 0)
	);

	function bandLabel(band: WorkoutTimingBucket['band']): string {
		if (band === 'early') return m.readiness_timing_early();
		if (band === 'evening') return m.readiness_timing_evening();
		return m.readiness_timing_late();
	}
</script>

{#if readiness !== null || hasTiming || vitals !== null}
	<section class="min-w-0 border-t border-ink pt-10" aria-labelledby="readiness-title">
		<h2 id="readiness-title" class="text-2xl">{m.readiness_title()}</h2>
		<p class="mt-2 max-w-[62ch] text-sm text-ink-3">{m.readiness_desc()}</p>

		<div class="mt-8 grid gap-x-12 gap-y-10 lg:grid-cols-2">
			{#if readiness !== null}
				<div class="min-w-0">
					<h3 class="text-base font-medium text-ink">{m.readiness_sleep_to_training()}</h3>

					{#if readiness.volumeLift !== null}
						<dl class="mt-3">
							<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
								<dt class="sr-only">{m.readiness_volume_diff()}</dt>
								<dd>
									<Measure
										value={`${formatSigned(readiness.volumeLift * 100, 0)}%`}
										class={cn(
											'text-3xl font-figure sm:text-4xl',
											readiness.volumeClear ? 'text-ink' : 'text-ink-2'
										)}
										unitClass="ml-[0.15em] text-[0.5em] font-medium text-ink-3"
									/>
								</dd>
								<dd class="text-sm text-ink-3">{m.readiness_volume_diff()}</dd>
							</div>
						</dl>
					{/if}

					<dl class="mt-5 space-y-4">
						{#if readiness.restedMeanVolume !== null}
							<div>
								<div class="flex items-baseline justify-between gap-4 text-sm">
									<dt class="text-ink-2">
										{m.readiness_well_rested({ days: readiness.restedDays })}
									</dt>
									<dd class="font-medium text-ink">
										{formatNumber(readiness.restedMeanVolume)} kg
									</dd>
								</div>
								<div class="mt-1.5 h-2 w-full bg-rule" aria-hidden="true">
									<div
										class="h-full bg-sun"
										style:width="{(readiness.restedMeanVolume / maxVolume) * 100}%"
									></div>
								</div>
							</div>
						{/if}

						{#if readiness.tiredMeanVolume !== null}
							<div>
								<div class="flex items-baseline justify-between gap-4 text-sm">
									<dt class="text-ink-2">
										{m.readiness_under_slept({ days: readiness.tiredDays })}
									</dt>
									<dd class="font-medium text-ink">
										{formatNumber(readiness.tiredMeanVolume)} kg
									</dd>
								</div>
								<div class="mt-1.5 h-2 w-full bg-rule" aria-hidden="true">
									<div
										class="h-full bg-ink-3/60"
										style:width="{(readiness.tiredMeanVolume / maxVolume) * 100}%"
									></div>
								</div>
							</div>
						{/if}
					</dl>

					{#if readiness.restedMeanRpe !== null && readiness.tiredMeanRpe !== null}
						<p class="mt-3 text-sm text-ink-3">
							{m.readiness_rpe_note({
								rested: readiness.restedMeanRpe.toFixed(1),
								tired: readiness.tiredMeanRpe.toFixed(1)
							})}
						</p>
					{/if}
				</div>
			{/if}

			{#if hasTiming}
				<div class="min-w-0">
					<h3 class="text-base font-medium text-ink">{m.readiness_timing_title()}</h3>
					<ul class="mt-4 divide-y divide-rule border-t border-b border-rule">
						{#each timing.filter((b) => b.nights > 0) as bucket (bucket.band)}
							<li class="flex items-center justify-between gap-6 py-3">
								<div class="min-w-0">
									<p class="text-sm font-medium text-ink">{bandLabel(bucket.band)}</p>
									<p class="mt-0.5 text-xs text-ink-3">
										{#if bucket.meanLatencyMin !== null}
											{m.readiness_timing_meta({
												nights: bucket.nights,
												latency: formatNumber(Math.round(bucket.meanLatencyMin))
											})}
										{:else}
											{m.nights_count({ count: bucket.nights })}
										{/if}
									</p>
								</div>
								{#if bucket.meanQuality !== null}
									<div class="flex shrink-0 items-center gap-3">
										<div class="hidden h-1.5 w-16 bg-rule sm:block" aria-hidden="true">
											<div
												class="h-full bg-sleep"
												style:width="{Math.min(100, Math.max(0, bucket.meanQuality))}%"
											></div>
										</div>
										<span class="w-11 text-right text-base font-figure text-ink">
											{Math.round(bucket.meanQuality)}%
										</span>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>

		{#if vitals !== null}
			<div class="mt-10 border-t border-rule pt-7">
				<h3 class="text-base font-medium text-ink">{m.readiness_vitals_title()}</h3>
				<dl class="mt-4 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3 sm:gap-x-12">
					{#if vitals.latestHrvMs !== null}
						<div class="flex min-w-0 flex-col gap-1">
							<dt class="text-sm text-ink-3">{m.readiness_hrv()}</dt>
							<dd>
								<Measure
									value={`${Math.round(vitals.latestHrvMs)} ms`}
									class="text-3xl font-figure sm:text-4xl"
									unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
								/>
							</dd>
							{#if vitals.hrvSpark.length >= 2}
								<dd class="mt-1 max-w-[14rem]" aria-hidden="true">
									<Sparkline values={vitals.hrvSpark} kind="line" color={CHART_COLORS.volume} />
								</dd>
							{/if}
							{#if vitals.hrvDeltaMs !== null}
								<dd class="text-sm text-ink-3">
									{m.readiness_vs_baseline({
										delta: `${formatSigned(vitals.hrvDeltaMs, 0)} ms`
									})}
								</dd>
							{/if}
						</div>
					{/if}

					{#if vitals.latestRhrBpm !== null}
						<div class="flex min-w-0 flex-col gap-1">
							<dt class="text-sm text-ink-3">{m.readiness_rhr()}</dt>
							<dd>
								<Measure
									value={`${Math.round(vitals.latestRhrBpm)} bpm`}
									class="text-3xl font-figure sm:text-4xl"
									unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
								/>
							</dd>
							{#if vitals.rhrSpark.length >= 2}
								<dd class="mt-1 max-w-[14rem]" aria-hidden="true">
									<Sparkline values={vitals.rhrSpark} kind="line" color={CHART_COLORS.volume} />
								</dd>
							{/if}
							{#if vitals.rhrDeltaBpm !== null}
								<dd class="text-sm text-ink-3">
									{m.readiness_vs_baseline({
										delta: `${formatSigned(vitals.rhrDeltaBpm, 1)} bpm`
									})}
								</dd>
							{/if}
						</div>
					{/if}

					{#if vitals.latestWeightKg !== null}
						<div class="flex min-w-0 flex-col gap-1">
							<dt class="text-sm text-ink-3">{m.readiness_weight()}</dt>
							<dd>
								<Measure
									value={`${vitals.latestWeightKg.toFixed(1)} kg`}
									class="text-3xl font-figure sm:text-4xl"
									unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
								/>
							</dd>
							{#if vitals.weightSpark.length >= 2}
								<dd class="mt-1 max-w-[14rem]" aria-hidden="true">
									<Sparkline values={vitals.weightSpark} kind="line" color={CHART_COLORS.volume} />
								</dd>
							{/if}
							{#if vitals.weightChangeKg !== null}
								<dd class="text-sm text-ink-3">
									{formatSigned(vitals.weightChangeKg, 1)} kg
									{#if vitals.latestBodyFatPct !== null}
										, {vitals.latestBodyFatPct.toFixed(1)}%
									{/if}
								</dd>
							{/if}
						</div>
					{/if}
				</dl>
			</div>
		{/if}
	</section>
{/if}
