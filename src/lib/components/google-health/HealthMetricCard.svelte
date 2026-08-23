<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import * as m from '$lib/paraglide/messages';
	import { formatDateLong } from '$lib/format';
	import { metricLabel } from '$lib/google-health/labels';
	import {
		formatDuration,
		formatMetricNumber,
		formatSummaryValue,
		trendDelta,
		type HealthMetric,
		type HealthSummary
	} from '$lib/google-health/view';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import TrendingDownIcon from '@lucide/svelte/icons/trending-down';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';

	type Props = {
		metric: HealthMetric;
		href: string;
		trend?: HealthSummary[];
	};

	let { metric, href, trend = [] }: Props = $props();

	const title = $derived(metricLabel(metric.dataType));
	const value = $derived(formatSummaryValue(metric, metric.latestSummary, m.health_recorded()));
	const delta = $derived(trendDelta(metric, trend));
	const deltaValue = $derived.by(() => {
		if (delta === null) return null;
		const amount =
			metric.aggregation === 'duration'
				? formatDuration(Math.abs(delta))
				: formatMetricNumber(Math.abs(delta), metric.primaryUnit);
		return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${amount}`;
	});
	const lastRecorded = $derived(
		metric.latestSummary.latestTimestamp ??
			new Date(`${metric.latestSummary.localDate}T00:00:00.000Z`).getTime()
	);
</script>

<a
	href={resolve(href as Pathname)}
	aria-label={m.health_open_metric({ metric: title })}
	class="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
	<Card.Root class="h-full transition-colors hover:bg-accent/40">
		<Card.Header>
			<div class="min-w-0">
				<Card.Title class="truncate">{title}</Card.Title>
				<Card.Description>{m.health_source()}: {metric.sourceLabel}</Card.Description>
			</div>
			<Card.Action>
				<ArrowRightIcon class="size-4 text-muted-foreground" aria-hidden="true" />
			</Card.Action>
		</Card.Header>
		<Card.Content class="flex items-end justify-between gap-3">
			<div class="min-w-0">
				<p class="text-lg font-semibold tracking-tight">{value}</p>
				<p class="truncate text-xs text-muted-foreground">
					{m.health_last_recorded({ date: formatDateLong(lastRecorded) })}
				</p>
			</div>
			{#if deltaValue !== null}
				<Badge variant="outline">
					{#if delta !== null && delta > 0}
						<TrendingUpIcon aria-hidden="true" />
					{:else if delta !== null && delta < 0}
						<TrendingDownIcon aria-hidden="true" />
					{/if}
					{deltaValue}
				</Badge>
			{/if}
		</Card.Content>
	</Card.Root>
</a>
