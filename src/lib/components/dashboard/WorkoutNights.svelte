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

	const BAND_CLASSES = {
		good: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
		fair: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
		poor: 'bg-red-500/15 text-red-700 dark:text-red-400'
	};
	const COLUMNS = 'grid-cols-[3.5rem_minmax(0,1fr)_auto_3.5rem]';
	const SHOWN_EXERCISES = 2;
</script>

<section class="rounded-lg border bg-card p-4" aria-labelledby="workout-nights-title">
	<h2 id="workout-nights-title" class="font-semibold tracking-tight">
		{m.workout_nights_title()}
	</h2>
	<p class="text-xs text-muted-foreground">{m.workout_nights_desc()}</p>
	<div
		class={cn(
			'mt-3 grid gap-3 border-b pb-1.5 text-[11px] text-muted-foreground uppercase',
			COLUMNS
		)}
		aria-hidden="true"
	>
		<span>{m.col_date()}</span>
		<span>{m.col_workout()}</span>
		<span class="text-right">{m.col_volume()}</span>
		<span class="text-right">{m.col_night()}</span>
	</div>
	<ul class="divide-y">
		{#each rows as { workout, quality } (workout.id)}
			{@const more = workout.exerciseTitles.length - SHOWN_EXERCISES}
			<li>
				<button
					type="button"
					aria-haspopup="dialog"
					class={cn(
						'-mx-2 grid w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
						COLUMNS
					)}
					onclick={() => onselect(workout.id)}
				>
					<span class="text-xs text-muted-foreground tabular-nums">
						{formatDate(workout.startTime)}
					</span>
					<span class="min-w-0">
						<span class="block truncate text-sm font-medium">{workout.title}</span>
						<span class="block truncate text-xs text-muted-foreground">
							{workout.exerciseTitles.slice(0, SHOWN_EXERCISES).join(', ')}{more > 0
								? ` +${more}`
								: ''}
						</span>
					</span>
					<span class="text-right text-sm tabular-nums">{formatNumber(workout.volume)} kg</span>
					<span class="flex items-center justify-end gap-1">
						{#if quality === null}
							<span class="text-xs text-muted-foreground">—</span>
						{:else}
							<span
								class={cn(
									'rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums',
									BAND_CLASSES[qualityBand(quality)]
								)}
							>
								{Math.round(quality)}%
							</span>
						{/if}
						<ChevronRightIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
					</span>
				</button>
			</li>
		{/each}
	</ul>
</section>
