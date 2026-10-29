<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		getExerciseSessions,
		getExercises,
		getScaleWeights
	} from '#lib/remote/imports.remote.js';
	import type { ExerciseMode, ExerciseSummary } from '#lib/server/workouts.js';
	import {
		formatPaceMinPerKm,
		primarySeriesForMode,
		summarizeExerciseProgression
	} from '#lib/progression.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Measure from '#lib/components/Measure.svelte';
	import StatCard from '#lib/components/dashboard/StatCard.svelte';
	import WeightChart from '#lib/components/dashboard/WeightChart.svelte';
	import VolumeChart from '#lib/components/dashboard/VolumeChart.svelte';
	import { formatDate, formatDateLong, formatHours, formatNumber } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const exercisesQuery = getExercises();
	const scaleWeightsQuery = getScaleWeights();

	const exercises = $derived(exercisesQuery.current ?? []);
	const scaleWeights = $derived(scaleWeightsQuery.current ?? []);

	let pickerOpen = $state(false);
	let selected = $state<string | null>(null);
	let weightedMetric = $state<'e1rm' | 'weight'>('e1rm');

	// Until one is picked, show the exercise trained most recently.
	const activeExerciseObj = $derived.by(() => {
		if (selected) {
			const match = exercises.find((exercise) => exercise.exerciseTitle === selected);
			if (match) return match;
		}
		let latest = exercises[0];
		for (const exercise of exercises) {
			if (exercise.lastPerformed > latest.lastPerformed) latest = exercise;
		}
		return latest;
	});
	const activeExercise = $derived(activeExerciseObj?.exerciseTitle ?? '');
	const mode = $derived<ExerciseMode>(activeExerciseObj?.mode ?? 'weighted');

	const sessionsQuery = $derived(activeExercise ? getExerciseSessions(activeExercise) : null);
	const sessions = $derived(sessionsQuery?.current ?? []);

	const progression = $derived(summarizeExerciseProgression(sessions, scaleWeights));

	const primaryData = $derived(primarySeriesForMode(progression.annotated, mode, weightedMetric));
	const primaryUnit = $derived.by(() => {
		if (mode === 'weighted') return 'kg';
		if (mode === 'bodyweight') return 'reps';
		if (mode === 'cardio') return 'min/km';
		return 'min';
	});

	const barData = $derived.by(() => {
		if (mode === 'bodyweight') {
			return sessions.map((s) => ({ date: new Date(s.startTime), volume: s.totalReps }));
		}
		if (mode === 'cardio') {
			return sessions.map((s) => ({
				date: new Date(s.startTime),
				volume: Number(s.distanceKm.toFixed(2))
			}));
		}
		if (mode === 'duration') {
			return sessions.map((s) => ({
				date: new Date(s.startTime),
				volume: Number((s.durationSeconds / 60).toFixed(1))
			}));
		}
		return sessions.map((s) => ({ date: new Date(s.startTime), volume: Math.round(s.volume) }));
	});
	const barUnit = $derived.by(() => {
		if (mode === 'bodyweight') return 'reps';
		if (mode === 'cardio') return 'km';
		if (mode === 'duration') return 'min';
		return undefined;
	});

	const hasError = $derived(
		exercisesQuery.error !== undefined || sessionsQuery?.error !== undefined
	);
	const isLoading = $derived(!hasError && !exercisesQuery.ready);
	const sessionsLoading = $derived(sessionsQuery !== null && !sessionsQuery.ready);

	function pick(exerciseTitle: string): void {
		selected = exerciseTitle;
		pickerOpen = false;
	}

	let search = $state('');
	const listed = $derived.by(() => {
		const query = search.trim().toLocaleLowerCase();
		if (!query) return exercises;
		return exercises.filter((exercise) =>
			exercise.exerciseTitle.toLocaleLowerCase().includes(query)
		);
	});

	function modeLabel(mType: ExerciseMode): string {
		if (mType === 'bodyweight') return m.ex_mode_bodyweight();
		if (mType === 'cardio') return m.ex_mode_cardio();
		if (mType === 'duration') return m.ex_mode_duration();
		return m.ex_mode_weighted();
	}

	function itemMeta(exercise: ExerciseSummary): string {
		const base = m.exercises_item_meta({
			count: exercise.setsCount,
			date: formatDate(exercise.lastPerformed, { day: 'numeric', month: 'short', year: 'numeric' })
		});
		return exercise.mode === 'weighted' ? base : `${base}, ${modeLabel(exercise.mode)}`;
	}
</script>

<svelte:head>
	<title>{m.exercises_title()}: {m.app_name()}</title>
</svelte:head>

<div
	class="flex flex-col gap-4 border-b border-rule pt-7 pb-3 sm:flex-row sm:items-end sm:justify-between"
>
	<h1 class="min-w-0 text-4xl">{m.exercises_title()}</h1>
	{#if exercises.length > 0}
		<!-- Below lg the ledger gives way to this picker; the selected exercise shows under it. -->
		<div class="lg:hidden">
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
							<ChevronsUpDownIcon class="text-ink-3" aria-hidden="true" />
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
											<span class="text-sm text-ink-3">{itemMeta(exercise)}</span>
										</div>
									</Command.Item>
								{/each}
							</Command.Group>
						</Command.List>
					</Command.Root>
				</Popover.Content>
			</Popover.Root>
		</div>
	{/if}
</div>

{#snippet detailSkeleton()}
	<div class="mt-6 flex gap-14">
		<Skeleton class="h-24 w-28" />
		<Skeleton class="h-24 w-36" />
		<Skeleton class="hidden h-24 w-40 sm:block" />
	</div>
	<Skeleton class="mt-14 h-6 w-48" />
	<Skeleton class="mt-5 h-[260px] w-full" />
{/snippet}

{#if isLoading}
	<div class="mt-8 grid gap-x-14 lg:grid-cols-[20rem_minmax(0,1fr)]" aria-busy="true">
		<div class="hidden flex-col gap-2 lg:flex">
			<Skeleton class="mb-2 h-9 w-full" />
			{#each { length: 7 }, row (row)}
				<Skeleton class="h-12 w-full" />
			{/each}
		</div>
		<div>
			<Skeleton class="h-8 w-64" />
			{@render detailSkeleton()}
		</div>
	</div>
{:else if exercises.length === 0}
	<Empty.Root class="mt-10 border border-rule">
		{#if hasError}
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.data_error_title()}</Empty.Title>
				<Empty.Description>{m.data_error_description()}</Empty.Description>
			</Empty.Header>
		{:else}
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.empty_title()}</Empty.Title>
				<Empty.Description>{m.exercises_empty()}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<a href={resolve('/dashboard/import')} class={buttonVariants()}>{m.empty_cta()}</a>
			</Empty.Content>
		{/if}
	</Empty.Root>
{:else}
	<!-- Master and detail: every exercise in a ledger on the left, the chosen one on the right. -->
	<div class="mt-8 grid items-start gap-x-14 lg:grid-cols-[20rem_minmax(0,1fr)]">
		<div
			class="hidden lg:sticky lg:top-[calc(var(--bar-height)+2rem)] lg:flex lg:max-h-[calc(100svh-var(--bar-height)-4rem)] lg:flex-col"
		>
			<Input
				type="search"
				bind:value={search}
				placeholder={m.exercises_search()}
				aria-label={m.exercises_search()}
			/>
			<ul
				class="mt-4 min-h-0 overflow-y-auto border-t border-ink"
				aria-label={m.exercises_select()}
			>
				{#each listed as exercise (exercise.exerciseTitle)}
					{@const current = exercise.exerciseTitle === activeExercise}
					<li class="border-b border-rule">
						<button
							type="button"
							aria-current={current ? 'true' : undefined}
							class={cn(
								'group block w-full py-2.5 pr-2 pl-4 text-left focus-visible:-outline-offset-2',
								current && 'shadow-[inset_2px_0_0_var(--color-sun)]'
							)}
							onclick={() => pick(exercise.exerciseTitle)}
						>
							<span
								class={cn(
									'block truncate underline-offset-4 transition-colors duration-(--dur-micro) group-hover:text-ink group-hover:underline group-hover:decoration-sun',
									current ? 'font-medium text-ink' : 'text-ink-2'
								)}
							>
								{exercise.exerciseTitle}
							</span>
							<span class="block truncate text-sm text-ink-3">{itemMeta(exercise)}</span>
						</button>
					</li>
				{:else}
					<li class="py-6 text-sm text-ink-3">{m.exercises_no_match()}</li>
				{/each}
			</ul>
		</div>

		<section class="min-w-0" aria-labelledby="exercise-name">
			<div class="flex flex-wrap items-baseline justify-between gap-4">
				<h2 id="exercise-name" class="text-2xl">{activeExercise}</h2>
				{#if progression.prCount > 0}
					<p class="text-sm text-ink-3">{m.ex_prs_logged({ count: progression.prCount })}</p>
				{/if}
			</div>

			{#if hasError}
				<Empty.Root class="mt-6 border border-rule">
					<Empty.Header>
						<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
						<Empty.Title>{m.data_error_title()}</Empty.Title>
						<Empty.Description>{m.data_error_description()}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else if sessionsLoading}
				<div aria-busy="true">
					{@render detailSkeleton()}
				</div>
			{:else}
				<dl class="mt-6 grid grid-cols-2 gap-x-8 gap-y-6 sm:flex sm:flex-wrap sm:gap-x-14">
					<StatCard
						title={m.ex_sessions()}
						value={String(progression.sessions)}
						subtitle={progression.last &&
							m.ex_last_session({ date: formatDateLong(progression.last.startTime) })}
					/>

					{#if mode === 'weighted'}
						<StatCard
							title={m.ex_est_1rm()}
							value="{formatNumber(progression.bestE1rm?.e1rm ?? 0, 1)} kg"
							subtitle={progression.bestE1rm && formatDateLong(progression.bestE1rm.startTime)}
						/>
						<StatCard
							title={m.ex_max_weight()}
							value="{formatNumber(progression.heaviest?.maxWeight ?? 0, 1)} kg"
							subtitle={progression.heaviest && formatDateLong(progression.heaviest.startTime)}
						/>
						{#if progression.bestRelativeE1rm !== undefined}
							<StatCard
								title={m.ex_relative_strength()}
								value="{progression.bestRelativeE1rm.ratio.toFixed(2)} x"
								subtitle={m.ex_relative_sub({
									weight: formatNumber(progression.bestRelativeE1rm.bodyweightKg, 1)
								})}
							/>
						{/if}
						<StatCard
							title={m.ex_best_volume()}
							value="{formatNumber(progression.biggestVolume?.volume ?? 0)} kg"
							subtitle={progression.biggestVolume &&
								formatDateLong(progression.biggestVolume.startTime)}
						/>
					{:else if mode === 'bodyweight'}
						<StatCard
							title={m.ex_max_reps()}
							value={m.ex_reps_unit({ count: progression.mostReps?.maxReps ?? 0 })}
							subtitle={progression.mostReps && formatDateLong(progression.mostReps.startTime)}
						/>
					{:else if mode === 'cardio'}
						<StatCard
							title={m.ex_best_distance()}
							value="{formatNumber(progression.longestDistance?.distanceKm ?? 0, 2)} km"
							subtitle={progression.longestDistance &&
								formatDateLong(progression.longestDistance.startTime)}
						/>
						{#if progression.fastestPaceMinPerKm !== undefined}
							<StatCard
								title={m.ex_best_pace()}
								value={formatPaceMinPerKm(progression.fastestPaceMinPerKm.value)}
								subtitle={formatDateLong(progression.fastestPaceMinPerKm.session.startTime)}
							/>
						{/if}
					{:else}
						<StatCard
							title={m.ex_best_duration()}
							value={formatHours(progression.longestDuration?.durationSeconds ?? 0)}
							subtitle={progression.longestDuration &&
								formatDateLong(progression.longestDuration.startTime)}
						/>
					{/if}
				</dl>

				{#if mode === 'weighted' && progression.repMaxes.length > 0}
					<section class="mt-12" aria-labelledby="exercise-repmax-title">
						<h3 id="exercise-repmax-title" class="text-xl">{m.ex_rep_maxes_title()}</h3>
						<p class="mt-1.5 text-sm text-ink-3">{m.ex_rep_maxes_desc()}</p>
						<dl class="mt-4 grid grid-cols-3 border-t border-ink sm:grid-cols-6">
							{#each progression.repMaxes as entry (entry.reps)}
								<div class="border-b border-rule py-3 pr-4">
									<dt class="text-xs font-medium text-ink-3">
										{m.ex_reps_target({ reps: entry.reps })}
									</dt>
									<dd class="mt-1">
										<Measure
											value="{formatNumber(entry.weight, 1)} kg"
											class="text-2xl font-figure"
											unitClass="ml-[0.15em] text-[0.5em] font-medium text-ink-3"
										/>
									</dd>
									<dd class="mt-0.5 text-xs text-ink-3">
										{formatDate(entry.startTime, { day: 'numeric', month: 'short' })}
									</dd>
								</div>
							{/each}
						</dl>
					</section>
				{/if}

				{#if primaryData.length > 0}
					<section class="mt-14" aria-labelledby="exercise-primary-title">
						<div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
							<div>
								<h3 id="exercise-primary-title" class="text-xl">
									{#if mode === 'weighted'}
										{weightedMetric === 'e1rm' ? m.ex_est_1rm() : m.ex_weight_progression()}
									{:else if mode === 'bodyweight'}
										{m.ex_max_reps()}
									{:else if mode === 'cardio'}
										{m.ex_pace_progression()}
									{:else}
										{m.ex_duration_progression()}
									{/if}
								</h3>
								<p class="mt-1.5 flex items-center gap-2 text-sm text-ink-2">
									<span class="h-0.5 w-4 bg-sun" aria-hidden="true"></span>
									{#if mode === 'weighted'}
										{weightedMetric === 'e1rm' ? m.ex_est_1rm_desc() : m.ex_weight_desc()}
									{:else if mode === 'bodyweight'}
										{m.ex_max_reps_desc()}
									{:else if mode === 'cardio'}
										{m.ex_pace_desc()}
									{:else}
										{m.ex_duration_desc()}
									{/if}
								</p>
							</div>

							{#if mode === 'weighted'}
								<ToggleGroup.Root
									type="single"
									bind:value={
										() => weightedMetric,
										(next) => {
											if (next === 'e1rm' || next === 'weight') weightedMetric = next;
										}
									}
									variant="outline"
									aria-label={m.ex_weight_progression()}
									class="w-full data-[variant=outline]:shadow-none sm:w-auto"
								>
									<ToggleGroup.Item value="e1rm" class="h-8 flex-1 px-2.5 text-xs sm:flex-none">
										{m.ex_metric_e1rm()}
									</ToggleGroup.Item>
									<ToggleGroup.Item value="weight" class="h-8 flex-1 px-2.5 text-xs sm:flex-none">
										{m.ex_metric_weight()}
									</ToggleGroup.Item>
								</ToggleGroup.Root>
							{/if}
						</div>

						<div class="mt-4">
							<WeightChart data={primaryData} unit={primaryUnit} />
						</div>
					</section>
				{/if}

				{#if barData.some((d) => d.volume > 0)}
					<section class="mt-12" aria-labelledby="exercise-volume-title">
						<h3 id="exercise-volume-title" class="text-xl">
							{#if mode === 'bodyweight'}
								{m.ex_total_reps()}
							{:else if mode === 'cardio'}
								{m.ex_distance_session()}
							{:else if mode === 'duration'}
								{m.ex_duration_progression()}
							{:else}
								{m.ex_volume_session()}
							{/if}
						</h3>
						<p class="mt-1.5 flex items-center gap-2 text-sm text-ink-2">
							<span class="size-2.5 bg-sun" aria-hidden="true"></span>
							{#if mode === 'bodyweight'}
								{m.ex_total_reps_desc()}
							{:else if mode === 'cardio'}
								{m.ex_distance_desc()}
							{:else if mode === 'duration'}
								{m.ex_duration_desc()}
							{:else}
								{m.ex_volume_desc()}
							{/if}
						</p>
						<div class="mt-4">
							<VolumeChart data={barData} unit={barUnit} />
						</div>
					</section>
				{/if}
			{/if}
		</section>
	</div>
{/if}
