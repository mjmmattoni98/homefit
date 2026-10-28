<script lang="ts">
	import { page } from '$app/state';
	import { getMetrics } from '#lib/remote/health.remote.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import HealthMetricCard from '#lib/components/google-health/HealthMetricCard.svelte';
	import HealthSyncBanner from '#lib/components/google-health/HealthSyncBanner.svelte';
	import { categoryLabel, metricLabel } from '#lib/google-health/labels.js';
	import { isHealthCategory } from '#lib/google-health/view.js';
	import * as m from '#lib/paraglide/messages.js';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const category = $derived.by(() => {
		const value = page.params.category;
		return value !== undefined && isHealthCategory(value) ? value : null;
	});
	const metricsQuery = $derived(category === null ? null : getMetrics(category));
	const metrics = $derived(
		[...(metricsQuery?.current ?? [])].sort((left, right) =>
			metricLabel(left.dataType).localeCompare(metricLabel(right.dataType))
		)
	);
	const isLoading = $derived(
		metricsQuery !== null && !metricsQuery.ready && metricsQuery.error === undefined
	);
</script>

<svelte:head>
	<title>
		{category === null ? m.health_not_found_title() : categoryLabel(category)} · {m.app_name()}
	</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">
			{category === null ? m.health_not_found_title() : categoryLabel(category)}
		</h1>
		{#if category !== null}
			<p class="text-sm text-muted-foreground">
				{m.health_category_description({ category: categoryLabel(category) })}
			</p>
		{/if}
	</div>

	<HealthSyncBanner />

	{#if category === null}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.health_not_found_title()}</Empty.Title>
				<Empty.Description>{m.health_not_found_description()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if isLoading}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{#each [0, 1, 2, 3, 4, 5, 6, 7] as index (index)}
				<Skeleton class="h-36 w-full" />
			{/each}
		</div>
	{:else if metricsQuery?.error !== undefined}
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
				<Empty.Title>{m.health_empty_category_title()}</Empty.Title>
				<Empty.Description>{m.health_empty_category_description()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
			{#each metrics as metric (metric.dataType)}
				<HealthMetricCard {metric} />
			{/each}
		</div>
	{/if}
</div>
