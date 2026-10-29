<script lang="ts">
	import type { WorkoutSummary } from '#lib/server/workouts.js';
	import { formatDate, formatNumber } from '#lib/format.js';
	import { qualityBand } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	let {
		rows,
		onselect
	}: {
		/** Newest first, with prior night readiness and the night that began on the workout's day. */
		rows: { workout: WorkoutSummary; priorQuality?: number | null; quality: number | null }[];
		onselect: (workoutId: string) => void;
	} = $props();

	const BAND_BARS = {
		good: 'bg-moon',
		fair: 'bg-sleep',
		poor: 'bg-sleep-dim'
	};
	const COLUMNS =
		'grid-cols-[3.75rem_minmax(0,1fr)_7.5rem] sm:grid-cols-[4.5rem_minmax(0,1fr)_auto_9.5rem]';
	const SHOWN_EXERCISES = 2;

	function effortMeta(workout: WorkoutSummary): string | null {
		const parts: string[] = [];
		if (workout.hardSets > 0) {
			parts.push(m.workout_hard_sets_badge({ count: workout.hardSets }));
		}
		if (workout.meanRpe !== undefined) {
			parts.push(m.workout_rpe_badge({ rpe: workout.meanRpe.toFixed(1) }));
		}
		return parts.length > 0 ? parts.join(', ') : null;
	}
</script>

<section class="min-w-0" aria-labelledby="workout-nights-title">
	<h2 id="workout-nights-title" class="text-2xl">{m.workout_nights_title()}</h2>
	<p class="mt-2 max-w-[60ch] text-sm text-ink-3">{m.workout_nights_desc()}</p>

	<div class="mt-6 border-t border-ink">
		<div class={cn('grid text-sm text-ink-3', COLUMNS)} aria-hidden="true">
			<span class="py-2.5">{m.col_date()}</span>
			<span class="py-2.5 pr-4">{m.col_workout()}</span>
			<span class="hidden py-2.5 pr-4 text-right sm:block">{m.col_volume()}</span>
			<span class="flex justify-between bg-night px-3 py-2.5 text-xs text-moon-2">
				<span>{m.col_night_before()}</span>
				<span class="pr-4">{m.col_night_after()}</span>
			</span>
		</div>
		<ul>
			{#each rows as { workout, priorQuality = null, quality } (workout.id)}
				{@const more = workout.exerciseTitles.length - SHOWN_EXERCISES}
				{@const effort = effortMeta(workout)}
				<li class="border-t border-rule">
					<button
						type="button"
						aria-haspopup="dialog"
						class={cn(
							'group grid w-full items-stretch text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
							COLUMNS
						)}
						onclick={() => onselect(workout.id)}
					>
						<span
							class="py-3 text-sm text-ink-3 transition-colors duration-(--dur-micro) group-hover:text-foreground"
						>
							{formatDate(workout.startTime)}
						</span>
						<span class="min-w-0 py-3 pr-4">
							<span
								class="block truncate font-medium underline-offset-4 group-hover:underline group-hover:decoration-sun"
								>{workout.title}</span
							>
							<span class="block truncate text-sm text-ink-3">
								{workout.exerciseTitles.slice(0, SHOWN_EXERCISES).join(', ')}{more > 0
									? ` +${more}`
									: ''}
							</span>
							{#if effort}
								<span class="mt-0.5 block truncate text-xs text-ink-3">{effort}</span>
							{/if}
							<span class="block text-sm whitespace-nowrap text-ink-2 sm:hidden"
								>{formatNumber(workout.volume)} kg</span
							>
						</span>
						<span class="hidden py-3 pr-4 text-right whitespace-nowrap sm:block"
							>{formatNumber(workout.volume)}
							<span class="text-sm text-ink-3">kg</span></span
						>
						<span
							class="relative grid grid-cols-2 items-center gap-2 bg-night py-3 pr-7 pl-3 text-moon transition-colors duration-(--dur-micro) group-hover:bg-night-2"
						>
							<span class="flex flex-col gap-1">
								{#if priorQuality === null}
									<span class="text-xs text-moon-2">—</span>
								{:else}
									<span class="text-base leading-none font-figure text-moon-2"
										>{Math.round(priorQuality)}%</span
									>
									<span class="block h-1 w-full bg-night-rule" aria-hidden="true">
										<span
											class={cn('block h-full opacity-75', BAND_BARS[qualityBand(priorQuality)])}
											style:width="{Math.min(100, Math.max(0, priorQuality))}%"
										></span>
									</span>
								{/if}
							</span>

							<span class="flex flex-col gap-1">
								{#if quality === null}
									<span class="text-xs text-moon-2">—</span>
								{:else}
									<span class="text-lg leading-none font-figure">{Math.round(quality)}%</span>
									<span class="block h-1 w-full bg-night-rule" aria-hidden="true">
										<span
											class={cn('block h-full', BAND_BARS[qualityBand(quality)])}
											style:width="{Math.min(100, Math.max(0, quality))}%"
										></span>
									</span>
								{/if}
							</span>

							<ChevronRightIcon
								class="absolute top-1/2 right-2 size-4 -translate-y-1/2 text-moon-2"
								aria-hidden="true"
							/>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>
</section>
