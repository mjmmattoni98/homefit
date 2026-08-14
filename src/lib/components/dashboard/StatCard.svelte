<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import type { Component } from 'svelte';

	let {
		title,
		value,
		subtitle,
		icon: Icon
	}: {
		title: string;
		value: string;
		subtitle?: string;
		icon?: Component;
	} = $props();
</script>

<Card.Root>
	<Card.Header class="flex flex-row items-center justify-between space-y-0 pb-2">
		<Card.Title class="text-sm font-medium text-muted-foreground">{title}</Card.Title>
		{#if Icon}
			<Icon class="size-4 text-muted-foreground" />
		{/if}
	</Card.Header>
	<Card.Content>
		<div class="text-2xl font-bold">{value}</div>
		{#if subtitle}
			<p class="text-xs text-muted-foreground">{subtitle}</p>
		{/if}
	</Card.Content>
</Card.Root>
