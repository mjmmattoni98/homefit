<script lang="ts">
	import { getExerciseSessions, getExercises } from '#lib/remote/imports.remote.js';
	import type { ExerciseSession } from '#lib/server/workouts.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import StatCard from '#lib/components/dashboard/StatCard.svelte';
	import WeightChart from '#lib/components/dashboard/WeightChart.svelte';
	import VolumeChart from '#lib/components/dashboard/VolumeChart.svelte';
	import { formatDate, formatDateLong, formatNumber } from '#lib/format.js';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import WeightIcon from '@lucide/svelte/icons/weight';
	import TrophyIcon from '@lucide/svelte/icons/trophy';

	const exercisesQuery = getExercises();

	const exercises = $derived(exercisesQuery.current ?? []);

	let pickerOpen = $state(false);
	let selected = $state<string | null>(null);
	// Until one is picked, show the exercise trained most recently.
	const activeExercise = $derived.by(() => {
		if (selected && exercises.some((exercise) => exercise.exerciseTitle === selected)) {
			return selected;
		}
		let latest = exercises[0];
		for (const exercise of exercises) {
			if (exercise.lastPerformed > latest.lastPerformed) latest = exercise;
		}
		return latest?.exerciseTitle ?? '';
	});

	const sessionsQuery = $derived(activeExercise ? getExerciseSessions(activeExercise) : null);
	const sessions = $derived(sessionsQuery?.current ?? []);

	// The first session reaching each record, so its date can be shown.
	const summary = $derived.by(() => {
		let heaviest: ExerciseSession | undefined;
		let biggest: ExerciseSession | undefined;
		for (const session of sessions) {
			if (session.maxWeight > (heaviest?.maxWeight ?? 0)) heaviest = session;
			if (session.volume > (biggest?.volume ?? 0)) biggest = session;
		}
		return { sessions: sessions.length, last: sessions.at(-1), heaviest, biggest };
	});

	const weightData = $derived(
		sessions
			.filter((s) => s.maxWeight > 0)
			.map((s) => ({ date: new Date(s.startTime), weight: s.maxWeight }))
	);
	const volumeData = $derived(
		sessions.map((s) => ({ date: new Date(s.startTime), volume: Math.round(s.volume) }))
	);

	const hasError = $derived(
		exercisesQuery.error !== undefined || sessionsQuery?.error !== undefined
	);
	const isLoading = $derived(!hasError && !exercisesQuery.ready);
	const sessionsLoading = $derived(sessionsQuery !== null && !sessionsQuery.ready);

	function pick(exerciseTitle: string): void {
		selected = exerciseTitle;
		pickerOpen = false;
	}
</script>

<svelte:head>
	<title>{m.exercises_title()} · {m.app_name()}</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-2xl font-bold tracking-tight">{m.exercises_title()}</h1>
		{#if exercises.length > 0}
			<Popover.Root bind:open={pickerOpen}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="outline"
							role="combobox"
							aria-expanded={pickerOpen}
							aria-label={m.exercises_select()}
							class="w-full justify-between sm:w-80"
						>
							<span class="truncate">{activeExercise || m.exercises_select()}</span>
							<ChevronsUpDownIcon class="opacity-50" aria-hidden="true" />
						</Button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content align="end" class="w-(--bits-popover-anchor-width) min-w-72 p-0">
					<Command.Root>
						<Command.Input placeholder={m.exercises_search()} />
						<Command.List>
							<Command.Empty>{m.exercises_no_match()}</Command.Empty>
							<Command.Group>
								{#each exercises as exercise (exercise.exerciseTitle)}
									<Command.Item
										value={exercise.exerciseTitle}
										data-checked={exercise.exerciseTitle === activeExercise}
										onSelect={() => pick(exercise.exerciseTitle)}
									>
										<div class="flex min-w-0 flex-col">
											<span class="truncate">{exercise.exerciseTitle}</span>
											<span class="text-xs text-muted-foreground">
												{m.exercises_item_meta({
													count: exercise.setsCount,
													date: formatDate(exercise.lastPerformed, {
														day: 'numeric',
														month: 'short',
														year: 'numeric'
													})
												})}
											</span>
										</div>
									</Command.Item>
								{/each}
							</Command.Group>
						</Command.List>
					</Command.Root>
				</Popover.Content>
			</Popover.Root>
		{/if}
	</div>

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-3">
			{#each Array(3) as _, i (i)}
				<Skeleton class="h-28 w-full" />
			{/each}
		</div>
		<Skeleton class="h-72 w-full" />
	{:else if hasError}
		<Card.Root>
			<Card.Content class="py-12 text-center">
				<p class="font-medium">{m.data_error_title()}</p>
				<p class="text-sm text-muted-foreground">{m.data_error_description()}</p>
			</Card.Content>
		</Card.Root>
	{:else if exercises.length === 0}
		<Card.Root>
			<Card.Content class="py-12 text-center text-muted-foreground">
				{m.exercises_empty()}
			</Card.Content>
		</Card.Root>
	{:else if sessionsLoading}
		<div class="grid gap-4 sm:grid-cols-3">
			{#each Array(3) as _, i (i)}
				<Skeleton class="h-28 w-full" />
			{/each}
		</div>
		<div class="grid gap-4 lg:grid-cols-2">
			<Skeleton class="h-80 w-full" />
			<Skeleton class="h-80 w-full" />
		</div>
	{:else}
		<div class="grid gap-4 sm:grid-cols-3">
			<StatCard
				title={m.ex_sessions()}
				value={String(summary.sessions)}
				subtitle={summary.last &&
					m.ex_last_session({ date: formatDateLong(summary.last.startTime) })}
				icon={CalendarIcon}
			/>
			<StatCard
				title={m.ex_max_weight()}
				value="{formatNumber(summary.heaviest?.maxWeight ?? 0, 1)} kg"
				subtitle={summary.heaviest && formatDateLong(summary.heaviest.startTime)}
				icon={WeightIcon}
			/>
			<StatCard
				title={m.ex_best_volume()}
				value="{formatNumber(summary.biggest?.volume ?? 0)} kg"
				subtitle={summary.biggest && formatDateLong(summary.biggest.startTime)}
				icon={TrophyIcon}
			/>
		</div>

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>{m.ex_weight_progression()}</Card.Title>
					<Card.Description>{m.ex_weight_desc()}</Card.Description>
				</Card.Header>
				<Card.Content>
					<WeightChart data={weightData} />
				</Card.Content>
			</Card.Root>
			<Card.Root>
				<Card.Header>
					<Card.Title>{m.ex_volume_session()}</Card.Title>
					<Card.Description>{m.ex_volume_desc()}</Card.Description>
				</Card.Header>
				<Card.Content>
					<VolumeChart data={volumeData} />
				</Card.Content>
			</Card.Root>
		</div>
	{/if}
</div>
