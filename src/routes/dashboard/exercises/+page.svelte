<script lang="ts">
	import { api } from '$convex/_generated/api';
	import { SvelteMap } from 'svelte/reactivity';
	import { useAuth, useQuery } from 'convex-svelte';
	import * as m from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import StatCard from '$lib/components/dashboard/StatCard.svelte';
	import WeightChart from '$lib/components/dashboard/WeightChart.svelte';
	import SessionVolumeChart from '$lib/components/dashboard/SessionVolumeChart.svelte';
	import { formatDateAxis, formatNumber } from '$lib/format';
	import { breakGaps } from '$lib/charts';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import WeightIcon from '@lucide/svelte/icons/weight';
	import TrophyIcon from '@lucide/svelte/icons/trophy';

	const auth = useAuth();
	const exercisesQuery = useQuery(api.workouts.listExercises, () =>
		auth.isAuthenticated ? {} : 'skip'
	);

	const exercises = $derived(exercisesQuery.data ?? []);

	let selected = $state<string | null>(null);
	const activeExercise = $derived.by(() => {
		if (selected && exercises.some((exercise) => exercise.exerciseTitle === selected)) {
			return selected;
		}
		return exercises[0]?.exerciseTitle ?? '';
	});

	const historyQuery = useQuery(api.workouts.exerciseHistory, () =>
		auth.isAuthenticated && activeExercise ? { exerciseTitle: activeExercise } : 'skip'
	);

	interface Session {
		startTime: number;
		maxWeight: number;
		volume: number;
		sets: number;
	}

	const sessions = $derived.by((): Session[] => {
		const sets = historyQuery.data ?? [];
		const bySession = new SvelteMap<number, Session>();
		for (const set of sets) {
			let session = bySession.get(set.startTime);
			if (!session) {
				session = { startTime: set.startTime, maxWeight: 0, volume: 0, sets: 0 };
				bySession.set(set.startTime, session);
			}
			session.sets++;
			if (set.weightKg != null) {
				session.maxWeight = Math.max(session.maxWeight, set.weightKg);
			}
			if (set.weightKg != null && set.reps != null) {
				session.volume += set.weightKg * set.reps;
			}
		}
		return [...bySession.values()].sort((a, b) => a.startTime - b.startTime);
	});

	const summary = $derived.by(() => ({
		sessions: sessions.length,
		maxWeight: sessions.reduce((max, s) => Math.max(max, s.maxWeight), 0),
		bestVolume: sessions.reduce((max, s) => Math.max(max, s.volume), 0)
	}));

	const weightData = $derived(
		breakGaps(
			sessions
				.filter((s) => s.maxWeight > 0)
				.map((s) => ({ date: new Date(s.startTime), weight: s.maxWeight }))
		)
	);
	const volumeData = $derived(
		sessions.map((s) => ({ label: formatDateAxis(s.startTime), volume: Math.round(s.volume) }))
	);

	const isLoading = $derived(auth.isLoading || (auth.isAuthenticated && exercisesQuery.isLoading));
</script>

<div class="flex flex-col gap-6">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-2xl font-bold tracking-tight">{m.exercises_title()}</h1>
		{#if exercises.length > 0}
			<Select.Root type="single" bind:value={() => activeExercise, (v) => (selected = v)}>
				<Select.Trigger class="w-full max-w-sm">
					{activeExercise || m.exercises_select()}
				</Select.Trigger>
				<Select.Content>
					{#each exercises as exercise (exercise.exerciseTitle)}
						<Select.Item value={exercise.exerciseTitle}>
							{exercise.exerciseTitle}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		{/if}
	</div>

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-3">
			{#each Array(3) as _, i (i)}
				<Skeleton class="h-28 w-full" />
			{/each}
		</div>
		<Skeleton class="h-72 w-full" />
	{:else if exercises.length === 0}
		<Card.Root>
			<Card.Content class="py-12 text-center text-muted-foreground">
				{m.exercises_empty()}
			</Card.Content>
		</Card.Root>
	{:else}
		<div class="grid gap-4 sm:grid-cols-3">
			<StatCard title={m.ex_sessions()} value={String(summary.sessions)} icon={CalendarIcon} />
			<StatCard
				title={m.ex_max_weight()}
				value="{formatNumber(summary.maxWeight, 1)} kg"
				icon={WeightIcon}
			/>
			<StatCard
				title={m.ex_best_volume()}
				value="{formatNumber(summary.bestVolume)} kg"
				icon={TrophyIcon}
			/>
		</div>

		{#if historyQuery.isLoading}
			<Skeleton class="h-72 w-full" />
		{:else}
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
						<SessionVolumeChart data={volumeData} />
					</Card.Content>
				</Card.Root>
			</div>
		{/if}
	{/if}
</div>
