<script lang="ts">
	import { resolve } from '$app/paths';
	import { getCategories, getMetrics } from '#lib/remote/health.remote.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import HealthMetricCard from '#lib/components/google-health/HealthMetricCard.svelte';
	import HealthSyncBanner from '#lib/components/google-health/HealthSyncBanner.svelte';
	import { categoryLabel, metricLabel } from '#lib/google-health/labels.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import DatabaseIcon from '@lucide/svelte/icons/database';

	const metricsQuery = getMetrics(null);
	const metrics = $derived(
		[...(metricsQuery.current ?? [])].sort((left, right) =>
			metricLabel(left.dataType).localeCompare(metricLabel(right.dataType))
		)
	);
	const isLoading = $derived(!metricsQuery.ready && metricsQuery.error === undefined);

	// The day's measurements first; sleep hangs below them on the night field.
	const dayMetrics = $derived(metrics.filter((metric) => metric.category !== 'sleep'));
	const nightMetrics = $derived(metrics.filter((metric) => metric.category === 'sleep'));

	// The same tabs as the health overview, with "All metrics" underlined.
	const categoriesQuery = getCategories();
	const tabs = $derived([
		{ href: resolve('/dashboard/health'), label: m.nav_overview(), current: false },
		...(categoriesQuery.current ?? []).map((item) => ({
			href: resolve('/dashboard/health/[category]', { category: item.category }),
			label: categoryLabel(item.category),
			current: false
		})),
		{ href: resolve('/dashboard/health/metrics'), label: m.nav_all_metrics(), current: true }
	]);
</script>

<svelte:head>
	<title>{m.health_all_metrics_title()}: {m.app_name()}</title>
</svelte:head>

<div
	class="flex flex-col gap-4 border-b border-rule pt-7 pb-3 lg:flex-row lg:items-end lg:justify-between"
>
	<div class="min-w-0">
		<h1 class="text-4xl">{m.health_all_metrics_title()}</h1>
		<p class="mt-1.5 text-sm text-ink-3">{m.health_all_metrics_description()}</p>
	</div>
	<nav aria-label={m.nav_health()} class="-mx-4 min-w-0 overflow-x-auto px-4 md:mx-0 md:px-0">
		<ul class="flex w-max shadow-[inset_0_-1px_0_var(--color-rule)]">
			{#each tabs as tab (tab.href)}
				<li>
					<a
						href={tab.href}
						aria-current={tab.current ? 'page' : undefined}
						class={cn(
							'flex h-10 items-center px-3 text-[0.9375rem] font-medium whitespace-nowrap text-ink-3 transition-colors duration-(--dur-micro) hover:text-foreground focus-visible:-outline-offset-2',
							tab.current && 'text-foreground shadow-[inset_0_-2px_0_var(--color-sun)]'
						)}
					>
						{tab.label}
					</a>
				</li>
			{/each}
		</ul>
	</nav>
</div>

<HealthSyncBanner />

{#if isLoading}
	<div class="mt-10 border-t border-ink pt-10" aria-busy="true">
		{#each [0, 1, 2, 3, 4, 5, 6, 7] as index (index)}
			<div class="flex items-center justify-between gap-10 border-b border-rule py-4">
				<Skeleton class="h-10 w-48" />
				<Skeleton class="h-10 w-32" />
			</div>
		{/each}
	</div>
{:else if metricsQuery.error !== undefined}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_query_error_title()}</Empty.Title>
			<Empty.Description>{m.health_query_error_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if metrics.length === 0}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_no_data_title()}</Empty.Title>
			<Empty.Description>{m.health_no_data_description()}</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<a href={resolve('/dashboard/import')} class={buttonVariants()}>{m.health_no_data_cta()}</a>
		</Empty.Content>
	</Empty.Root>
{:else}
	<!-- Every metric as one ledger, A to Z; the sleep metrics follow on the night field and keep
	     the ledger's columns. -->
	<div class="mt-10 grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 border-t border-ink">
		<div
			class="col-span-full grid grid-cols-subgrid py-2.5 text-sm text-ink-3 max-sm:hidden"
			aria-hidden="true"
		>
			<span></span>
			<span class="text-right">{m.health_latest()}</span>
		</div>
		{#if dayMetrics.length > 0}
			<ul class="col-span-full grid grid-cols-subgrid">
				{#each dayMetrics as metric (metric.dataType)}
					<li class="col-span-full grid grid-cols-subgrid border-t border-rule">
						<HealthMetricCard {metric} />
					</li>
				{/each}
			</ul>
		{/if}
		{#if nightMetrics.length > 0}
			<ul
				class="col-span-full -mx-4 grid grid-cols-subgrid bg-night px-4 text-moon md:-mx-5 md:px-5"
				aria-label={categoryLabel('sleep')}
			>
				{#each nightMetrics as metric (metric.dataType)}
					<li
						class="col-span-full grid grid-cols-subgrid border-t border-night-rule first:border-t-0"
					>
						<HealthMetricCard {metric} />
					</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}
