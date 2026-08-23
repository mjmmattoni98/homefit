<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { api } from '$convex/_generated/api';
	import { useAuth, useQuery } from 'convex-svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { buttonVariants } from '$lib/components/ui/button';
	import HealthMetricCard from '$lib/components/google-health/HealthMetricCard.svelte';
	import HealthSyncBanner from '$lib/components/google-health/HealthSyncBanner.svelte';
	import HealthTrendChart from '$lib/components/google-health/HealthTrendChart.svelte';
	import { categoryLabel, metricLabel } from '$lib/google-health/labels';
	import { summaryNumber } from '$lib/google-health/view';
	import * as m from '$lib/paraglide/messages';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const auth = useAuth();
	const overviewQuery = useQuery(api.googleHealth.records.getOverview, () =>
		auth.isAuthenticated ? { days: 30 } : 'skip'
	);
	const categoriesQuery = useQuery(api.googleHealth.records.listCategories, () =>
		auth.isAuthenticated ? {} : 'skip'
	);
	const activityQuery = useQuery(api.googleHealth.records.listMetrics, () =>
		auth.isAuthenticated ? { category: 'activity' as const } : 'skip'
	);

	const overview = $derived(overviewQuery.data);
	const categories = $derived(categoriesQuery.data ?? []);
	const recentActivity = $derived(
		[...(activityQuery.data ?? [])]
			.sort(
				(left, right) =>
					(right.latestSummary.latestTimestamp ?? 0) - (left.latestSummary.latestTimestamp ?? 0)
			)
			.slice(0, 4)
	);
	const chartMetric = $derived(
		overview?.metrics.find((metric) =>
			metric.trend.some((summary) => summaryNumber(metric, summary) !== null)
		)
	);
	const isLoading = $derived(
		auth.isLoading ||
			!auth.isAuthenticated ||
			overviewQuery.isLoading ||
			categoriesQuery.isLoading ||
			activityQuery.isLoading
	);
	const hasError = $derived(
		overviewQuery.error !== undefined ||
			categoriesQuery.error !== undefined ||
			activityQuery.error !== undefined
	);
</script>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">{m.health_overview_title()}</h1>
		<p class="text-sm text-muted-foreground">{m.health_overview_description()}</p>
	</div>

	<HealthSyncBanner />

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each [0, 1, 2, 3] as index (index)}
				<Skeleton class="h-36 w-full" />
			{/each}
		</div>
		<Skeleton class="h-80 w-full" />
	{:else if hasError}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.health_query_error_title()}</Empty.Title>
				<Empty.Description>{m.health_query_error_description()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if overview === undefined || overview.metrics.length === 0}
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
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each overview.metrics as metric (metric.dataType)}
				<HealthMetricCard
					{metric}
					trend={metric.trend}
					href={`/dashboard/health/metrics/${encodeURIComponent(metric.dataType)}`}
				/>
			{/each}
		</div>

		{#if chartMetric !== undefined}
			<Card.Root>
				<Card.Header>
					<Card.Title>{m.health_trend_title()}: {metricLabel(chartMetric.dataType)}</Card.Title>
					<Card.Description>
						{m.health_trend_description({ metric: metricLabel(chartMetric.dataType) })}
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<HealthTrendChart metric={chartMetric} summaries={chartMetric.trend} />
				</Card.Content>
			</Card.Root>
		{/if}

		<div class="grid gap-4 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>{m.health_recent_title()}</Card.Title>
					<Card.Description>{m.health_recent_description()}</Card.Description>
				</Card.Header>
				<Card.Content>
					{#if recentActivity.length === 0}
						<p class="text-sm text-muted-foreground">{m.health_no_records()}</p>
					{:else}
						<ul class="divide-y">
							{#each recentActivity as metric (metric.dataType)}
								<li class="flex items-center justify-between gap-3 py-2.5">
									<a
										href={resolve(
											`/dashboard/health/metrics/${encodeURIComponent(metric.dataType)}` as Pathname
										)}
										class="min-w-0 truncate font-medium hover:underline"
									>
										{metricLabel(metric.dataType)}
									</a>
									<Badge variant="secondary">{metric.latestSummary.count}</Badge>
								</li>
							{/each}
						</ul>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>{m.health_categories_title()}</Card.Title>
					<Card.Description>{m.health_categories_description()}</Card.Description>
				</Card.Header>
				<Card.Content class="flex flex-col gap-1">
					{#each categories as item (item.category)}
						{@const href = `/dashboard/health/${item.category}`}
						<a
							href={resolve(href as Pathname)}
							class="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
						>
							<span class="font-medium">{categoryLabel(item.category)}</span>
							<Badge variant="outline" class="ml-auto">
								{m.health_metric_count({ count: item.count })}
							</Badge>
							<ArrowRightIcon class="size-4 text-muted-foreground" aria-hidden="true" />
						</a>
					{/each}
					<a
						href={resolve('/dashboard/health/metrics' as Pathname)}
						class="mt-1 flex items-center gap-2 rounded-md px-2 py-2 font-medium hover:bg-accent"
					>
						{m.health_all_metrics_link()}
						<ArrowRightIcon class="ml-auto size-4" aria-hidden="true" />
					</a>
				</Card.Content>
			</Card.Root>
		</div>
	{/if}
</div>
