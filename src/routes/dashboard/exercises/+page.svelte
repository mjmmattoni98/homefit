<script lang="ts">
	import { resolve } from '$app/paths';
	import { getExerciseSessions, getExercises } from '#lib/remote/imports.remote.js';
	import type { ExerciseSession, ExerciseSummary } from '#lib/server/workouts.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import StatCard from '#lib/components/dashboard/StatCard.svelte';
	import WeightChart from '#lib/components/dashboard/WeightChart.svelte';
	import VolumeChart from '#lib/components/dashboard/VolumeChart.svelte';
	import { formatDate, formatDateLong, formatNumber } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import DatabaseIcon from '@lucide/svelte/icons/database';

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

	// The ledger beside the detail (lg and up) filters itself; the picker below lg filters inside
	// its command menu.
	let search = $state('');
	const listed = $derived.by(() => {
		const query = search.trim().toLocaleLowerCase();
		if (!query) return exercises;
		return exercises.filter((exercise) =>
			exercise.exerciseTitle.toLocaleLowerCase().includes(query)
		);
	});

	function itemMeta(exercise: ExerciseSummary): string {
		return m.exercises_item_meta({
			count: exercise.setsCount,
			date: formatDate(exercise.lastPerformed, { day: 'numeric', month: 'short', year: 'numeric' })
		});
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
			<h2 id="exercise-name" class="text-2xl">{activeExercise}</h2>

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
						value={String(summary.sessions)}
						subtitle={summary.last &&
							m.ex_last_session({ date: formatDateLong(summary.last.startTime) })}
					/>
					<StatCard
						title={m.ex_max_weight()}
						value="{formatNumber(summary.heaviest?.maxWeight ?? 0, 1)} kg"
						subtitle={summary.heaviest && formatDateLong(summary.heaviest.startTime)}
					/>
					<StatCard
						title={m.ex_best_volume()}
						value="{formatNumber(summary.biggest?.volume ?? 0)} kg"
						subtitle={summary.biggest && formatDateLong(summary.biggest.startTime)}
					/>
				</dl>

				<section class="mt-14" aria-labelledby="exercise-weight-title">
					<h3 id="exercise-weight-title" class="text-xl">{m.ex_weight_progression()}</h3>
					<p class="mt-1.5 flex items-center gap-2 text-sm text-ink-2">
						<span class="h-0.5 w-4 bg-sun" aria-hidden="true"></span>
						{m.ex_weight_desc()}
					</p>
					<div class="mt-4">
						<WeightChart data={weightData} />
					</div>
				</section>

				<section class="mt-12" aria-labelledby="exercise-volume-title">
					<h3 id="exercise-volume-title" class="text-xl">{m.ex_volume_session()}</h3>
					<p class="mt-1.5 flex items-center gap-2 text-sm text-ink-2">
						<span class="size-2.5 bg-sun" aria-hidden="true"></span>
						{m.ex_volume_desc()}
					</p>
					<div class="mt-4">
						<VolumeChart data={volumeData} />
					</div>
				</section>
			{/if}
		</section>
	</div>
{/if}
