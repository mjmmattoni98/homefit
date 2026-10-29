<script lang="ts">
	import { formatSigned } from '#lib/format.js';
	import type { SleepFactor } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';

	let { factors, description }: { factors: SleepFactor[]; description: string } = $props();

	// Bars are scaled to the largest difference, but never so far that small ones look dramatic.
	const scale = $derived(Math.max(5, ...factors.map((factor) => Math.abs(factor.difference ?? 0))));
	const COLUMNS = 'grid-cols-[minmax(0,1fr)_6rem_3.5rem] sm:grid-cols-[minmax(0,1fr)_10rem_3.5rem]';
</script>

<!-- A piece of the night field: every factor here is measured on the nights. -->
<section
	class="min-w-0 bg-night px-5 pt-6 pb-5 text-moon sm:px-7"
	aria-labelledby="sleep-factors-title"
>
	<h2 id="sleep-factors-title" class="text-2xl">{m.factors_title()}</h2>
	<p class="mt-2 text-sm text-moon-2">{description}</p>

	<div
		class={cn('mt-6 grid gap-3 border-b border-night-rule pb-2 text-sm text-moon-2', COLUMNS)}
		aria-hidden="true"
	>
		<span>{m.factors_col_factor()}</span>
		<span class="flex justify-between">
			<span>{m.factors_worse()}</span><span>{m.factors_better()}</span>
		</span>
		<span class="text-right">{m.factors_col_difference()}</span>
	</div>
	<ul class="divide-y divide-night-rule">
		{#each factors as factor (factor.note ?? '')}
			{@const width = ((Math.abs(factor.difference ?? 0) / scale) * 50).toFixed(1)}
			<li class={cn('grid items-center gap-3 py-3', COLUMNS)}>
				<div class="min-w-0">
					<p class="truncate font-medium">{factor.note ?? m.factor_trained()}</p>
					<p class="text-sm text-moon-2">
						{m.factor_meta({
							nights: m.nights_count({ count: factor.nights }),
							average: Math.round(factor.average)
						})}
					</p>
				</div>
				<!-- Diverging from the centre: worse to the left, better to the right. -->
				<div class="relative h-3" aria-hidden="true">
					<span class="absolute -inset-y-1.5 left-1/2 w-px bg-moon-2/60"></span>
					{#if factor.difference !== null}
						<span
							class={cn('absolute inset-y-0', factor.clear ? 'bg-sleep' : 'bg-moon-2/40')}
							style:left={factor.difference > 0 ? '50%' : undefined}
							style:right={factor.difference < 0 ? '50%' : undefined}
							style:width="{width}%"
						></span>
					{/if}
				</div>
				<span
					class={cn(
						'text-right',
						factor.difference === null || !factor.clear ? 'text-moon-2' : 'font-semibold text-moon'
					)}
				>
					{#if factor.difference === null}
						<span class="sr-only">{m.no_data_in_range()}</span>
					{:else}
						{formatSigned(factor.difference, 1)}
					{/if}
				</span>
			</li>
		{/each}
	</ul>
	<p class="mt-4 text-sm text-moon-2">{m.notes_impact_footnote()}</p>
</section>
