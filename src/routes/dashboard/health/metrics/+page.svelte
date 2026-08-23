<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { api } from '$convex/_generated/api';
	import { useAuth, useQuery } from 'convex-svelte';
	import * as Empty from '$lib/components/ui/empty';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { buttonVariants } from '$lib/components/ui/button';
	import HealthMetricCard from '$lib/components/google-health/HealthMetricCard.svelte';
	import HealthSyncBanner from '$lib/components/google-health/HealthSyncBanner.svelte';
	import { metricLabel } from '$lib/google-health/labels';
	import * as m from '$lib/paraglide/messages';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const auth = useAuth();
	const metricsQuery = useQuery(api.googleHealth.records.listMetrics, () =>
		auth.isAuthenticated ? { category: null } : 'skip'
	);
	const metrics = $derived(
		[...(metricsQuery.data ?? [])].sort((left, right) =>
			metricLabel(left.dataType).localeCompare(metricLabel(right.dataType))
		)
	);
	const isLoading = $derived(auth.isLoading || !auth.isAuthenticated || metricsQuery.isLoading);
</script>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">{m.health_all_metrics_title()}</h1>
		<p class="text-sm text-muted-foreground">{m.health_all_metrics_description()}</p>
	</div>

	<HealthSyncBanner />

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{#each [0, 1, 2, 3, 4, 5, 6, 7] as index (index)}
				<Skeleton class="h-36 w-full" />
			{/each}
		</div>
	{:else if metricsQuery.error}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.health_query_error_title()}</Empty.Title>
				<Empty.Description>{m.health_query_error_description()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if metrics.length === 0}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.health_no_data_title()}</Empty.Title>
				<Empty.Description>{m.health_no_data_description()}</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<a href={resolve('/dashboard/import' as Pathname)} class={buttonVariants()}>
					{m.health_no_data_cta()}
				</a>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{#each metrics as metric (metric.dataType)}
				<HealthMetricCard
					{metric}
					href={`/dashboard/health/metrics/${encodeURIComponent(metric.dataType)}`}
				/>
			{/each}
		</div>
	{/if}
</div>
