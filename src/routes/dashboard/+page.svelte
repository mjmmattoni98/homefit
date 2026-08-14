<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { api } from '$convex/_generated/api';
	import { SvelteMap } from 'svelte/reactivity';
	import { useAuth, useQuery } from 'convex-svelte';
	import * as m from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import * as Table from '$lib/components/ui/table';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Badge } from '$lib/components/ui/badge';
	import { buttonVariants } from '$lib/components/ui/button';
	import StatCard from '$lib/components/dashboard/StatCard.svelte';
	import SleepQualityChart from '$lib/components/dashboard/SleepQualityChart.svelte';
	import SleepDurationChart from '$lib/components/dashboard/SleepDurationChart.svelte';
	import VolumeChart from '$lib/components/dashboard/VolumeChart.svelte';
	import { dayKey, formatDate, formatDateAxis, formatHours, formatNumber, sleepNightKey } from '$lib/format';
	import { breakGaps } from '$lib/charts';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import BedDoubleIcon from '@lucide/svelte/icons/bed-double';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const DAY_MS = 24 * 60 * 60 * 1000;

	const auth = useAuth();
	const sleepQuery = useQuery(api.sleep.list, () => (auth.isAuthenticated ? {} : 'skip'));
	const workoutsQuery = useQuery(api.workouts.listWorkouts, () =>
		auth.isAuthenticated ? {} : 'skip'
	);

	const records = $derived(sleepQuery.data ?? []);
	const workouts = $derived(workoutsQuery.data ?? []);
	const isLoading = $derived(
		auth.isLoading ||
			(auth.isAuthenticated && (sleepQuery.isLoading || workoutsQuery.isLoading))
	);
	const hasData = $derived(records.length > 0 || workouts.length > 0);

	// Exclude naps / incomplete nights from statistics
	const mainSleeps = $derived(records.filter((r) => r.timeAsleepSeconds >= 3 * 3600));

	const stats = $derived.by(() => {
		const now = Date.now();
		const last30 = mainSleeps.filter((r) => r.wokeUp >= now - 30 * DAY_MS);
		const avg = (xs: number[]) =>
			xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
		return {
			avgQuality: avg(last30.map((r) => r.sleepQuality)),
			avgAsleep: avg(last30.map((r) => r.timeAsleepSeconds)),
			nights30: last30.length,
			weekWorkouts: workouts.filter((w) => w.startTime >= now - 7 * DAY_MS).length,
			volume30: workouts
				.filter((w) => w.startTime >= now - 30 * DAY_MS)
				.reduce((s, w) => s + w.volume, 0)
		};
	});

	const qualityData = $derived(
		breakGaps(mainSleeps.map((r) => ({ date: new Date(r.wokeUp), quality: r.sleepQuality })))
	);
	const durationData = $derived(
		breakGaps(
			mainSleeps.map((r) => ({
				date: new Date(r.wokeUp),
				inBed: Math.round((r.timeInBedSeconds / 3600) * 10) / 10,
				asleep: Math.round((r.timeAsleepSeconds / 3600) * 10) / 10
			}))
		)
	);
	const volumeData = $derived(
		[...workouts]
			.reverse()
			.map((w) => ({ label: formatDateAxis(w.startTime), volume: Math.round(w.volume) }))
	);

	const correlations = $derived.by(() => {
		const workoutDays = new Set(workouts.map((w) => dayKey(w.startTime)));
		const training: number[] = [];
		const rest: number[] = [];
		for (const r of mainSleeps) {
			if (workoutDays.has(sleepNightKey(r.wentToBed))) training.push(r.sleepQuality);
			else rest.push(r.sleepQuality);
		}
		const avg = (xs: number[]) =>
			xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
		return {
			trainingAvg: avg(training),
			trainingNights: training.length,
			restAvg: avg(rest),
			restNights: rest.length
		};
	});

	const notesImpact = $derived.by(() => {
		if (mainSleeps.length === 0) return [];
		const overall =
			mainSleeps.reduce((s, r) => s + r.sleepQuality, 0) / mainSleeps.length;
		const byNote = new SvelteMap<string, number[]>();
		for (const r of mainSleeps) {
			for (const note of r.notes) {
				const list = byNote.get(note);
				if (list) list.push(r.sleepQuality);
				else byNote.set(note, [r.sleepQuality]);
			}
		}
		return [...byNote.entries()]
			.map(([note, qualities]) => ({
				note,
				nights: qualities.length,
				avg: qualities.reduce((a, b) => a + b, 0) / qualities.length
			}))
			.filter((x) => x.nights >= 2)
			.sort((a, b) => b.nights - a.nights)
			.slice(0, 10)
			.map((x) => ({ ...x, delta: x.avg - overall }));
	});

	const recentWorkouts = $derived(workouts.slice(0, 6));
</script>

<div class="flex flex-col gap-6">
	<h1 class="text-2xl font-bold tracking-tight">{m.dashboard_title()}</h1>

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-28 w-full" />
			{/each}
		</div>
		<Skeleton class="h-72 w-full" />
	{:else if !hasData}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon">
					<DatabaseIcon />
				</Empty.Media>
				<Empty.Title>{m.empty_title()}</Empty.Title>
				<Empty.Description>{m.empty_desc()}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<a href={resolve('/dashboard/import' as Pathname)} class={buttonVariants()}>
					{m.empty_cta()}
				</a>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<StatCard
				title={m.stat_avg_quality()}
				value={stats.avgQuality != null ? `${Math.round(stats.avgQuality)}%` : '—'}
				subtitle="{m.last_30_days()} · {m.nights_count({ count: stats.nights30 })}"
				icon={MoonIcon}
			/>
			<StatCard
				title={m.stat_avg_asleep()}
				value={stats.avgAsleep != null ? formatHours(stats.avgAsleep) : '—'}
				subtitle={m.last_30_days()}
				icon={BedDoubleIcon}
			/>
			<StatCard
				title={m.stat_workouts_week()}
				value={String(stats.weekWorkouts)}
				subtitle={m.last_7_days()}
				icon={DumbbellIcon}
			/>
			<StatCard
				title={m.stat_volume()}
				value="{formatNumber(stats.volume30)} kg"
				subtitle={m.last_30_days()}
				icon={TrendingUpIcon}
			/>
		</div>

		{#if qualityData.length > 1}
			<div class="grid gap-4 lg:grid-cols-2">
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.sleep_quality_trend()}</Card.Title>
						<Card.Description>{m.sleep_quality_desc()}</Card.Description>
					</Card.Header>
					<Card.Content>
						<SleepQualityChart data={qualityData} />
					</Card.Content>
				</Card.Root>
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.sleep_duration()}</Card.Title>
						<Card.Description>{m.sleep_duration_desc()}</Card.Description>
					</Card.Header>
					<Card.Content>
						<SleepDurationChart data={durationData} />
					</Card.Content>
				</Card.Root>
			</div>
		{/if}

		{#if workouts.length > 0}
			<div class="grid gap-4 lg:grid-cols-2">
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.volume_trend()}</Card.Title>
						<Card.Description>{m.volume_trend_desc()}</Card.Description>
					</Card.Header>
					<Card.Content>
						<VolumeChart data={volumeData} />
					</Card.Content>
				</Card.Root>
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.recent_workouts()}</Card.Title>
						<Card.Description>{m.workouts_count({ count: workouts.length })}</Card.Description>
					</Card.Header>
					<Card.Content>
						<ul class="divide-y">
							{#each recentWorkouts as workout (workout._id)}
								<li class="flex items-center justify-between gap-2 py-2.5">
									<div class="min-w-0">
										<p class="truncate text-sm font-medium">{workout.title}</p>
										<p class="text-xs text-muted-foreground">
											{formatDate(workout.startTime)} · {workout.setsCount}
											{m.sets().toLowerCase()}
										</p>
									</div>
									<Badge variant="secondary">{formatNumber(workout.volume)} kg</Badge>
								</li>
							{/each}
						</ul>
					</Card.Content>
				</Card.Root>
			</div>
		{/if}

		{#if mainSleeps.length > 0}
			<section class="flex flex-col gap-4">
				<div>
					<h2 class="text-xl font-semibold tracking-tight">{m.correlations_title()}</h2>
					<p class="text-sm text-muted-foreground">{m.correlations_desc()}</p>
				</div>

				<div class="grid gap-4 sm:grid-cols-2">
					<StatCard
						title={m.training_day()}
						value={correlations.trainingAvg != null
							? `${Math.round(correlations.trainingAvg)}%`
							: '—'}
						subtitle={m.nights_count({ count: correlations.trainingNights })}
						icon={DumbbellIcon}
					/>
					<StatCard
						title={m.rest_day()}
						value={correlations.restAvg != null ? `${Math.round(correlations.restAvg)}%` : '—'}
						subtitle={m.nights_count({ count: correlations.restNights })}
						icon={MoonIcon}
					/>
				</div>

				{#if notesImpact.length > 0}
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.notes_impact_title()}</Card.Title>
							<Card.Description>{m.notes_impact_desc()}</Card.Description>
						</Card.Header>
						<Card.Content>
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.note()}</Table.Head>
										<Table.Head class="text-right">{m.nights()}</Table.Head>
										<Table.Head class="text-right">{m.avg_quality()}</Table.Head>
										<Table.Head class="text-right">{m.delta_vs_avg()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each notesImpact as row (row.note)}
										<Table.Row>
											<Table.Cell class="font-medium">{row.note}</Table.Cell>
											<Table.Cell class="text-right">{row.nights}</Table.Cell>
											<Table.Cell class="text-right">{Math.round(row.avg)}%</Table.Cell>
											<Table.Cell
												class={row.delta >= 0
													? 'text-right text-green-600 dark:text-green-400'
													: 'text-right text-red-600 dark:text-red-400'}
											>
												{row.delta >= 0 ? '+' : ''}{row.delta.toFixed(1)}
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						</Card.Content>
					</Card.Root>
				{/if}
			</section>
		{/if}
	{/if}
</div>
