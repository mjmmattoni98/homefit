<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getCategories, getMetrics } from '#lib/remote/health.remote.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import HealthMetricCard from '#lib/components/google-health/HealthMetricCard.svelte';
	import HealthSyncBanner from '#lib/components/google-health/HealthSyncBanner.svelte';
	import { categoryLabel, metricLabel } from '#lib/google-health/labels.js';
	import { isHealthCategory } from '#lib/google-health/view.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
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

	// The same tabs as the health overview, with this category underlined.
	const categoriesQuery = getCategories();
	const tabs = $derived([
		{ href: resolve('/dashboard/health'), label: m.nav_overview(), current: false },
		...(categoriesQuery.current ?? []).map((item) => ({
			href: resolve('/dashboard/health/[category]', { category: item.category }),
			label: categoryLabel(item.category),
			current: item.category === category
		})),
		{ href: resolve('/dashboard/health/metrics'), label: m.nav_all_metrics(), current: false }
	]);

	// Sleep is measured on the nights, so its category is a night panel.
	const night = $derived(category === 'sleep');
</script>

<svelte:head>
	<title>
		{category === null ? m.health_not_found_title() : categoryLabel(category)}: {m.app_name()}
	</title>
</svelte:head>

<div
	class="flex flex-col gap-4 border-b border-rule pt-7 pb-3 lg:flex-row lg:items-end lg:justify-between"
>
	<div class="min-w-0">
		<h1 class="text-4xl">
			{category === null ? m.health_not_found_title() : categoryLabel(category)}
		</h1>
		{#if category !== null}
			<p class="mt-1.5 text-sm text-ink-3">
				{m.health_category_description({ category: categoryLabel(category) })}
			</p>
		{/if}
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

{#if category === null}
	<Empty.Root class="mt-10 border border-rule">
		<Empty.Header>
			<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
			<Empty.Title>{m.health_not_found_title()}</Empty.Title>
			<Empty.Description>{m.health_not_found_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else if isLoading}
	<div class="mt-10 border-t border-ink pt-10" aria-busy="true">
		{#each [0, 1, 2, 3, 4] as index (index)}
			<div class="flex items-center justify-between gap-10 border-b border-rule py-4">
				<Skeleton class="h-10 w-48" />
				<Skeleton class="h-10 w-32" />
			</div>
		{/each}
	</div>
{:else if metricsQuery?.error !== undefined}
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
			<Empty.Title>{m.health_empty_category_title()}</Empty.Title>
			<Empty.Description>{m.health_empty_category_description()}</Empty.Description>
		</Empty.Header>
	</Empty.Root>
{:else}
	<!-- A ledger of the category's metrics, each row a link to its records. -->
	<div class={cn('mt-10', night && 'bg-night px-5 pt-3 pb-2 text-moon sm:px-7')}>
		<div
			class={cn(
				'grid grid-cols-[minmax(0,1fr)_auto] gap-x-6',
				night ? 'border-t border-moon-2' : 'border-t border-ink'
			)}
		>
			<div
				class={cn(
					'col-span-full grid grid-cols-subgrid py-2.5 text-sm max-sm:hidden',
					night ? 'text-moon-2' : 'text-ink-3'
				)}
				aria-hidden="true"
			>
				<span></span>
				<span class="text-right">{m.health_latest()}</span>
			</div>
			<ul class="col-span-full grid grid-cols-subgrid">
				{#each metrics as metric (metric.dataType)}
					<li
						class={cn(
							'col-span-full grid grid-cols-subgrid border-t',
							night ? 'border-night-rule' : 'border-rule'
						)}
					>
						<HealthMetricCard {metric} />
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
