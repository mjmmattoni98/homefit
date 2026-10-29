<script lang="ts">
	import Measure from '#lib/components/Measure.svelte';
	import { formatNumber } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import ArrowDownRightIcon from '@lucide/svelte/icons/arrow-down-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';

	// One lead figure: its label, the figure in the condensed cut, then what it refers to. No box
	// and no icon. It renders a term and its details, so place several inside one `<dl>`.
	let {
		title,
		value,
		subtitle,
		change = null,
		changeLabel,
		class: className
	}: {
		title: string;
		value: string;
		subtitle?: string;
		/** Relative change against the previous period (0.05 = 5 % more). */
		change?: number | null;
		/** What the change compares against, e.g. "vs previous 30 days". */
		changeLabel?: string;
		class?: string;
	} = $props();

	const percent = $derived(change === null ? null : Math.round(change * 100));
</script>

<div class={cn('flex min-w-0 flex-col gap-1', className)}>
	<dt class="text-sm text-ink-3">{title}</dt>
	<dd class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
		<Measure
			{value}
			class="text-4xl font-figure sm:text-5xl"
			unitClass="ml-[0.2em] text-[0.45em] font-medium text-ink-3"
		/>
		{#if percent !== null}
			<span
				class={cn(
					'inline-flex shrink-0 items-center gap-0.5 text-sm',
					percent === 0 ? 'text-ink-3' : 'text-ink-2'
				)}
				title={changeLabel}
			>
				{#if percent > 0}
					<ArrowUpRightIcon class="size-3.5" aria-hidden="true" />
				{:else if percent < 0}
					<ArrowDownRightIcon class="size-3.5" aria-hidden="true" />
				{/if}
				{percent > 0 ? '+' : percent < 0 ? '−' : ''}{formatNumber(Math.abs(percent))}%
				{#if changeLabel}
					<span class="sr-only">{changeLabel}</span>
				{/if}
			</span>
		{/if}
	</dd>
	{#if subtitle}
		<dd class="truncate text-sm text-ink-3">{subtitle}</dd>
	{/if}
</div>
