<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { formatNumber } from '#lib/format.js';
	import TrendingDownIcon from '@lucide/svelte/icons/trending-down';
	import TrendingUpIcon from '@lucide/svelte/icons/trending-up';
	import type { Component } from 'svelte';

	let {
		title,
		value,
		subtitle,
		icon: Icon,
		change = null,
		changeLabel
	}: {
		title: string;
		value: string;
		subtitle?: string;
		icon?: Component;
		/** Relative change against the previous period (0.05 = 5 % more). */
		change?: number | null;
		/** What the change compares against, e.g. "vs previous 30 days". */
		changeLabel?: string;
	} = $props();

	const percent = $derived(change === null ? null : Math.round(change * 100));
</script>

<Card.Root>
	<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
		<Card.Title class="text-sm font-medium text-muted-foreground">{title}</Card.Title>
		{#if Icon}
			<Icon class="size-4 text-muted-foreground" />
		{/if}
	</Card.Header>
	<Card.Content class="flex items-end justify-between gap-3">
		<div class="min-w-0">
			<div class="text-2xl font-bold">{value}</div>
			{#if subtitle}
				<p class="text-xs text-muted-foreground">{subtitle}</p>
			{/if}
		</div>
		{#if percent !== null}
			<Badge variant="outline" class="shrink-0" title={changeLabel}>
				{#if percent > 0}
					<TrendingUpIcon aria-hidden="true" />
				{:else if percent < 0}
					<TrendingDownIcon aria-hidden="true" />
				{/if}
				{percent > 0 ? '+' : percent < 0 ? '−' : ''}{formatNumber(Math.abs(percent))}%
				{#if changeLabel}
					<span class="sr-only">{changeLabel}</span>
				{/if}
			</Badge>
		{/if}
	</Card.Content>
</Card.Root>
