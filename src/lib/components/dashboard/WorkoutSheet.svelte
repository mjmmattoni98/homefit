<script lang="ts">
	import { getWorkout } from '#lib/remote/imports.remote.js';
	import type { WorkoutDetail } from '#lib/server/workouts.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
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
		return parts.join(' · ') || '—';
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content class="w-full overflow-y-auto sm:max-w-md">
		{#if isLoading}
			<Sheet.Header>
				<Sheet.Title class="sr-only">{m.loading()}</Sheet.Title>
				<Skeleton class="h-5 w-40" />
				<Skeleton class="h-4 w-56" />
			</Sheet.Header>
			<div class="flex flex-col gap-3 px-4">
				<Skeleton class="h-16 w-full" />
				<Skeleton class="h-40 w-full" />
			</div>
		{:else if !workout}
			<Sheet.Header>
				<Sheet.Title>{m.workout_not_found()}</Sheet.Title>
			</Sheet.Header>
		{:else}
			<Sheet.Header>
				<Sheet.Title class="text-base">{workout.title}</Sheet.Title>
				<Sheet.Description>
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
			<div class="flex flex-col gap-5 px-4 pb-6">
				<dl class="grid grid-cols-3 gap-2 text-center">
					<div class="border p-2">
						<dt class="text-muted-foreground">{m.workout_duration()}</dt>
						<dd class="font-semibold">
							{formatDuration((workout.endTime - workout.startTime) / 1000)}
						</dd>
					</div>
					<div class="border p-2">
						<dt class="text-muted-foreground">{m.sets()}</dt>
						<dd class="font-semibold">{totals.sets}</dd>
					</div>
					<div class="border p-2">
						<dt class="text-muted-foreground">{m.workout_volume()}</dt>
						<dd class="font-semibold">{formatNumber(totals.volume)} kg</dd>
					</div>
				</dl>
				{#if workout.description}
					<p class="whitespace-pre-line text-muted-foreground">{workout.description}</p>
				{/if}
				{#each workout.exercises as exercise (exercise.exerciseTitle)}
					<section class="flex flex-col gap-1.5">
						<h3 class="text-sm font-medium">{exercise.exerciseTitle}</h3>
						{#if exercise.notes}
							<p class="text-muted-foreground">{exercise.notes}</p>
						{/if}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="w-12">{m.workout_set()}</Table.Head>
									<Table.Head>{m.workout_performed()}</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each exercise.sets as set, index (index)}
									<Table.Row>
										<Table.Cell class="tabular-nums">{set.setIndex + 1}</Table.Cell>
										<Table.Cell class="tabular-nums">
											{describeSet(set)}
											{#if SET_TYPES[set.setType]}
												<Badge variant="secondary" class="ml-1.5">
													{SET_TYPES[set.setType]()}
												</Badge>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</section>
				{/each}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>
