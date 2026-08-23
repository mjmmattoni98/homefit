<script lang="ts">
	import { page } from '$app/state';
	import { api } from '$convex/_generated/api';
	import { useAuth, usePaginatedQuery, useQuery } from 'convex-svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import * as Table from '$lib/components/ui/table';
	import * as ToggleGroup from '$lib/components/ui/toggle-group';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
	import HealthSyncBanner from '$lib/components/google-health/HealthSyncBanner.svelte';
	import HealthTrendChart from '$lib/components/google-health/HealthTrendChart.svelte';
	import { categoryLabel, metricLabel } from '$lib/google-health/labels';
	import {
		dateRange,
		formatDuration,
		formatMetricNumber,
		formatSummaryValue,
		isHealthDataType,
		payloadPath,
		payloadValue
	} from '$lib/google-health/view';
	import { formatDateLong } from '$lib/format';
	import * as m from '$lib/paraglide/messages';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const RANGE_DAYS = [7, 30, 90, 365] as const;

	const auth = useAuth();
	const dataType = $derived.by(() => {
		const value = page.params.dataType;
		return value !== undefined && isHealthDataType(value) ? value : null;
	});
	let rangeValue = $state('30');
	const rangeDays = $derived(Number(rangeValue));

	const metricsQuery = useQuery(api.googleHealth.records.listMetrics, () =>
		auth.isAuthenticated && dataType !== null ? { category: null } : 'skip'
	);
	const metric = $derived(metricsQuery.data?.find((item) => item.dataType === dataType));
	const selectedRange = $derived(
		metric === undefined ? null : dateRange(metric.latestSummary.localDate, rangeDays)
	);
	const trendQuery = useQuery(api.googleHealth.records.getMetricTrend, () =>
		auth.isAuthenticated && dataType !== null && selectedRange !== null
			? { dataType, ...selectedRange }
			: 'skip'
	);
	const recordsQuery = usePaginatedQuery(
		api.googleHealth.records.listMetricRecords,
		() => (auth.isAuthenticated && dataType !== null ? { dataType } : 'skip'),
		{ initialNumItems: 8 }
	);

	const trend = $derived(trendQuery.data?.kind === 'found' ? trendQuery.data.summaries : []);
	const records = $derived(recordsQuery.results);
	const isLoading = $derived(
		auth.isLoading ||
			!auth.isAuthenticated ||
			(dataType !== null && (metricsQuery.isLoading || recordsQuery.status === 'LoadingFirstPage'))
	);
	const hasError = $derived(
		metricsQuery.error !== undefined ||
			trendQuery.error !== undefined ||
			recordsQuery.error !== undefined
	);

	function recordValue(primaryValue: number | null, primaryUnit: string | null): string {
		return primaryValue === null
			? m.health_recorded()
			: formatMetricNumber(primaryValue, primaryUnit);
	}
</script>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">
			{metric === undefined
				? dataType === null
					? m.health_not_found_title()
					: metricLabel(dataType)
				: metricLabel(metric.dataType)}
		</h1>
		{#if metric !== undefined}
			<div class="mt-1 flex flex-wrap items-center gap-2">
				<Badge variant="secondary">{categoryLabel(metric.category)}</Badge>
				<span class="text-sm text-muted-foreground">
					{m.health_source()}: {metric.sourceLabel}
				</span>
			</div>
		{/if}
	</div>

	<HealthSyncBanner />

	{#if isLoading}
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
			{#each [0, 1, 2, 3] as index (index)}
				<Skeleton class="h-28 w-full" />
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
	{:else if dataType === null || metric === undefined}
		<Empty.Root class="border">
			<Empty.Header>
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>{m.health_not_found_title()}</Empty.Title>
				<Empty.Description>{m.health_not_found_description()}</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<section aria-labelledby="health-summary-heading" class="flex flex-col gap-3">
			<h2 id="health-summary-heading" class="text-lg font-semibold tracking-tight">
				{m.health_stats_title()}
			</h2>
			<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<Card.Root size="sm">
					<Card.Header><Card.Title>{m.health_latest()}</Card.Title></Card.Header>
					<Card.Content class="text-lg font-semibold">
						{formatSummaryValue(metric, metric.latestSummary, m.health_recorded())}
					</Card.Content>
				</Card.Root>
				{#if metric.latestSummary.average !== null}
					<Card.Root size="sm">
						<Card.Header><Card.Title>{m.health_average()}</Card.Title></Card.Header>
						<Card.Content class="text-lg font-semibold">
							{formatMetricNumber(metric.latestSummary.average, metric.primaryUnit)}
						</Card.Content>
					</Card.Root>
				{/if}
				{#if metric.latestSummary.min !== null}
					<Card.Root size="sm">
						<Card.Header><Card.Title>{m.health_minimum()}</Card.Title></Card.Header>
						<Card.Content class="text-lg font-semibold">
							{formatMetricNumber(metric.latestSummary.min, metric.primaryUnit)}
						</Card.Content>
					</Card.Root>
				{/if}
				{#if metric.latestSummary.max !== null}
					<Card.Root size="sm">
						<Card.Header><Card.Title>{m.health_maximum()}</Card.Title></Card.Header>
						<Card.Content class="text-lg font-semibold">
							{formatMetricNumber(metric.latestSummary.max, metric.primaryUnit)}
						</Card.Content>
					</Card.Root>
				{/if}
				{#if metric.aggregation === 'sum' && metric.latestSummary.sum !== null}
					<Card.Root size="sm">
						<Card.Header><Card.Title>{m.health_total()}</Card.Title></Card.Header>
						<Card.Content class="text-lg font-semibold">
							{formatMetricNumber(metric.latestSummary.sum, metric.primaryUnit)}
						</Card.Content>
					</Card.Root>
				{/if}
				{#if metric.aggregation === 'duration' && metric.latestSummary.durationSeconds !== null}
					<Card.Root size="sm">
						<Card.Header><Card.Title>{m.health_duration()}</Card.Title></Card.Header>
						<Card.Content class="text-lg font-semibold">
							{formatDuration(metric.latestSummary.durationSeconds)}
						</Card.Content>
					</Card.Root>
				{/if}
				<Card.Root size="sm">
					<Card.Header><Card.Title>{m.health_count()}</Card.Title></Card.Header>
					<Card.Content class="text-lg font-semibold">{metric.latestSummary.count}</Card.Content>
				</Card.Root>
			</div>
		</section>

		<Card.Root>
			<Card.Header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<Card.Title>{m.health_trend_title()}</Card.Title>
					<Card.Description>
						{m.health_trend_description({ metric: metricLabel(metric.dataType) })}
					</Card.Description>
				</div>
				<ToggleGroup.Root type="single" value={rangeValue} variant="outline" size="sm">
					{#each RANGE_DAYS as days (days)}
						<ToggleGroup.Item
							value={String(days)}
							aria-label={m.health_range_days({ days })}
							onclick={() => (rangeValue = String(days))}
						>
							{days}
						</ToggleGroup.Item>
					{/each}
				</ToggleGroup.Root>
			</Card.Header>
			<Card.Content>
				{#if trendQuery.isLoading}
					<Skeleton class="h-[260px] w-full" />
				{:else}
					<HealthTrendChart {metric} summaries={trend} />
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title>{m.health_records_title()}</Card.Title>
				<Card.Description>{m.health_records_description()}</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if records.length === 0}
					<p class="text-sm text-muted-foreground">{m.health_no_records()}</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>{m.health_date()}</Table.Head>
								<Table.Head>{m.health_value()}</Table.Head>
								<Table.Head>{m.health_application()}</Table.Head>
								<Table.Head>{m.health_device()}</Table.Head>
								<Table.Head>{m.health_method()}</Table.Head>
								<Table.Head>{m.health_details()}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each records as record, index (index)}
								<Table.Row>
									<Table.Cell class="whitespace-nowrap">
										{formatDateLong(record.recordTimestamp)}
									</Table.Cell>
									<Table.Cell class="font-medium">
										{recordValue(record.primaryValue, record.primaryUnit)}
									</Table.Cell>
									<Table.Cell>{record.sourceApplication ?? record.sourcePlatform ?? '−'}</Table.Cell
									>
									<Table.Cell>{record.sourceDevice ?? '−'}</Table.Cell>
									<Table.Cell>{record.recordingMethod ?? '−'}</Table.Cell>
									<Table.Cell class="min-w-56">
										{#if record.payload.kind === 'fields' && record.payload.fields.length > 0}
											<details>
												<summary class="cursor-pointer font-medium">
													{m.health_details()}
												</summary>
												<dl class="mt-2 grid gap-2">
													{#each record.payload.fields as field (`${field.path.join('.')}:${String(field.value)}`)}
														<div>
															<dt class="text-xs text-muted-foreground">
																{payloadPath(field.path, m.health_value())}
															</dt>
															<dd class="break-words">{payloadValue(field.value)}</dd>
														</div>
													{/each}
												</dl>
											</details>
										{:else}
											<span class="text-muted-foreground">{m.health_payload_unavailable()}</span>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}

				{#if recordsQuery.status === 'CanLoadMore' || recordsQuery.status === 'LoadingMore'}
					<div class="mt-4 flex justify-center">
						<Button
							variant="outline"
							disabled={recordsQuery.status === 'LoadingMore'}
							onclick={() => recordsQuery.loadMore(8)}
						>
							{#if recordsQuery.status === 'LoadingMore'}
								<Spinner data-icon="inline-start" />
								{m.health_loading_more()}
							{:else}
								{m.health_load_more()}
							{/if}
						</Button>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
