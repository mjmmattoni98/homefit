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
		/** Newest first, with the quality of the night that began on the workout's day. */
		rows: { workout: WorkoutSummary; quality: number | null }[];
		onselect: (workoutId: string) => void;
	} = $props();

	// The night column is a strip of the night field: good nights in full moonlight, fair ones
	// dimmer, poor ones dimmest.
	const BAND_BARS = {
		good: 'bg-moon',
		fair: 'bg-sleep',
		poor: 'bg-sleep-dim'
	};
	const COLUMNS =
		'grid-cols-[3.75rem_minmax(0,1fr)_6.5rem] sm:grid-cols-[4.5rem_minmax(0,1fr)_auto_8rem]';
	const SHOWN_EXERCISES = 2;
</script>

<section class="min-w-0" aria-labelledby="workout-nights-title">
	<h2 id="workout-nights-title" class="text-2xl">{m.workout_nights_title()}</h2>
	<p class="mt-2 max-w-[60ch] text-sm text-ink-3">{m.workout_nights_desc()}</p>

	<div class="mt-6 border-t border-ink">
		<div class={cn('grid text-sm text-ink-3', COLUMNS)} aria-hidden="true">
			<span class="py-2.5">{m.col_date()}</span>
			<span class="py-2.5 pr-4">{m.col_workout()}</span>
			<span class="hidden py-2.5 pr-4 text-right sm:block">{m.col_volume()}</span>
			<span class="bg-night px-3 py-2.5 text-moon-2">{m.col_night()}</span>
		</div>
		<ul>
			{#each rows as { workout, quality } (workout.id)}
				{@const more = workout.exerciseTitles.length - SHOWN_EXERCISES}
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
							<span class="block text-sm whitespace-nowrap text-ink-2 sm:hidden"
								>{formatNumber(workout.volume)} kg</span
							>
						</span>
						<span class="hidden py-3 pr-4 text-right whitespace-nowrap sm:block"
							>{formatNumber(workout.volume)}
							<span class="text-sm text-ink-3">kg</span></span
						>
						<span
							class="relative flex flex-col justify-center gap-1.5 bg-night py-3 pr-8 pl-3 text-moon transition-colors duration-(--dur-micro) group-hover:bg-night-2"
						>
							{#if quality === null}
								<span class="text-sm text-moon-2">{m.chart_not_tracked()}</span>
							{:else}
								<span class="text-xl leading-none font-figure">{Math.round(quality)}%</span>
								<span class="block h-1 w-full bg-night-rule" aria-hidden="true">
									<span
										class={cn('block h-full', BAND_BARS[qualityBand(quality)])}
										style:width="{Math.min(100, Math.max(0, quality))}%"
									></span>
								</span>
							{/if}
							<ChevronRightIcon
								class="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-moon-2"
								aria-hidden="true"
							/>
						</span>
					</button>
				</li>
			{/each}
		</ul>
	</div>
</section>
