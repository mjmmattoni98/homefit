<script lang="ts">
	import { getWorkout } from '#lib/remote/imports.remote.js';
	import type { WorkoutDetail } from '#lib/server/workouts.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Measure from '#lib/components/Measure.svelte';
	import { formatDate, formatNumber } from '#lib/format.js';
	import { formatDuration } from '#lib/google-health/view.js';
	import * as m from '#lib/paraglide/messages.js';

	type WorkoutSet = WorkoutDetail['exercises'][number]['sets'][number];

	let { workoutId, open = $bindable(false) }: { workoutId: string | null; open?: boolean } =
		$props();

	const workoutQuery = $derived(workoutId === null ? null : getWorkout(workoutId));
	const workout = $derived(workoutQuery?.current);
	const isLoading = $derived(
		workoutQuery === null || (!workoutQuery.ready && workoutQuery.error === undefined)
	);
	const totals = $derived.by(() => {
		let sets = 0;
		let volume = 0;
		for (const exercise of workout?.exercises ?? []) {
			for (const set of exercise.sets) {
				sets++;
				if (set.weightKg != null && set.reps != null) volume += set.weightKg * set.reps;
			}
		}
		return { sets, volume };
	});

	const SET_TYPES: Record<string, () => string> = {
		warmup: () => m.set_type_warmup(),
		dropset: () => m.set_type_dropset(),
		failure: () => m.set_type_failure()
	};

	function describeSet(set: WorkoutSet): string {
		const parts: string[] = [];
		if (set.weightKg != null && set.reps != null) {
			parts.push(`${formatNumber(set.weightKg, 2)} kg × ${formatNumber(set.reps)}`);
		} else if (set.reps != null) {
			parts.push(`× ${formatNumber(set.reps)}`);
		} else if (set.weightKg != null) {
			parts.push(`${formatNumber(set.weightKg, 2)} kg`);
		}
		if (set.distanceKm != null) parts.push(`${formatNumber(set.distanceKm, 2)} km`);
		if (set.durationSeconds != null) parts.push(formatDuration(set.durationSeconds));
		if (set.rpe != null) parts.push(`RPE ${formatNumber(set.rpe, 1)}`);
		return parts.join(', ') || '—';
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content
		class="gap-0 overflow-y-auto text-base data-[side=right]:w-full data-[side=right]:sm:max-w-lg"
	>
		{#if isLoading}
			<Sheet.Header class="gap-2 border-b border-rule px-6 pt-6 pb-5">
				<Sheet.Title class="sr-only">{m.loading()}</Sheet.Title>
				<Skeleton class="h-7 w-40" />
				<Skeleton class="h-4 w-56" />
			</Sheet.Header>
			<div class="flex flex-col gap-10 px-6 pt-6" aria-busy="true">
				<div class="flex gap-10">
					<Skeleton class="h-16 w-20" />
					<Skeleton class="h-16 w-16" />
					<Skeleton class="h-16 w-28" />
				</div>
				<Skeleton class="h-48 w-full" />
			</div>
		{:else if !workout}
			<Sheet.Header class="px-6 pt-6 pr-14">
				<Sheet.Title class="text-2xl">{m.workout_not_found()}</Sheet.Title>
			</Sheet.Header>
		{:else}
			<Sheet.Header class="gap-1.5 border-b border-rule px-6 pt-6 pr-14 pb-5">
				<Sheet.Title class="text-2xl">{workout.title}</Sheet.Title>
				<Sheet.Description class="text-ink-3">
					{formatDate(workout.startTime, {
						weekday: 'long',
						day: 'numeric',
						month: 'long',
						year: 'numeric',
						hour: '2-digit',
						minute: '2-digit'
					})}
				</Sheet.Description>
			</Sheet.Header>

			<div class="px-6 pt-6 pb-12">
				<!-- The workout's lead figures, then its sets as one small ledger per exercise. -->
				<dl class="flex flex-wrap gap-x-10 gap-y-5">
					<div class="flex min-w-0 flex-col gap-1">
						<dt class="text-sm text-ink-3">{m.workout_duration()}</dt>
						<dd>
							<Measure
								value={formatDuration((workout.endTime - workout.startTime) / 1000)}
								class="text-4xl font-figure"
								unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
							/>
						</dd>
					</div>
					<div class="flex min-w-0 flex-col gap-1">
						<dt class="text-sm text-ink-3">{m.sets()}</dt>
						<dd class="text-4xl font-figure">{totals.sets}</dd>
					</div>
					<div class="flex min-w-0 flex-col gap-1">
						<dt class="text-sm text-ink-3">{m.workout_volume()}</dt>
						<dd>
							<Measure
								value="{formatNumber(totals.volume)} kg"
								class="text-4xl font-figure"
								unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
							/>
						</dd>
					</div>
				</dl>
				{#if workout.description}
					<p class="mt-6 whitespace-pre-line text-ink-2">{workout.description}</p>
				{/if}

				{#each workout.exercises as exercise, exerciseIndex (exercise.exerciseTitle)}
					{@const titleId = `workout-exercise-${exerciseIndex}`}
					<section class="mt-10" aria-labelledby={titleId}>
						<h3 id={titleId} class="text-lg">{exercise.exerciseTitle}</h3>
						{#if exercise.notes}
							<p class="mt-1 text-sm text-ink-3">{exercise.notes}</p>
						{/if}
						<table class="mt-3 w-full border-t border-ink text-left">
							<thead>
								<tr class="text-sm text-ink-3">
									<th scope="col" class="w-14 py-2 font-normal">{m.workout_set()}</th>
									<th scope="col" class="py-2 font-normal">{m.workout_performed()}</th>
								</tr>
							</thead>
							<tbody>
								{#each exercise.sets as set, index (index)}
									<tr class="border-t border-rule align-baseline">
										<td class="py-2.5 text-ink-3">{set.setIndex + 1}</td>
										<td class="py-2.5">
											<span class="flex items-baseline justify-between gap-4">
												<span>{describeSet(set)}</span>
												{#if SET_TYPES[set.setType]}
													<span class="shrink-0 text-sm text-ink-3">
														{SET_TYPES[set.setType]()}
													</span>
												{/if}
											</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</section>
				{/each}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
