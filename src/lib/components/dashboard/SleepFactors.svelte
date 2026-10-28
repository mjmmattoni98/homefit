<script lang="ts">
	import { formatSigned } from '#lib/format.js';
	import type { SleepFactor } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';

	let { factors, description }: { factors: SleepFactor[]; description: string } = $props();

	// Bars are scaled to the largest difference, but never so far that small ones look dramatic.
	const scale = $derived(Math.max(5, ...factors.map((factor) => Math.abs(factor.difference ?? 0))));
	const COLUMNS = 'grid-cols-[minmax(0,1fr)_6rem_3.5rem] sm:grid-cols-[minmax(0,1fr)_9rem_3.5rem]';
</script>

<section class="rounded-lg border bg-card p-4" aria-labelledby="sleep-factors-title">
	<h2 id="sleep-factors-title" class="font-semibold tracking-tight">{m.factors_title()}</h2>
	<p class="text-xs text-muted-foreground">{description}</p>
	<div
		class={cn(
			'mt-3 grid gap-3 border-b pb-1.5 text-[11px] text-muted-foreground uppercase',
			COLUMNS
		)}
		aria-hidden="true"
	>
		<span>{m.factors_col_factor()}</span>
		<span class="flex justify-between">
			<span>{m.factors_worse()}</span><span>{m.factors_better()}</span>
		</span>
		<span class="text-right">{m.factors_col_difference()}</span>
	</div>
	<ul class="divide-y">
		{#each factors as factor (factor.note ?? '')}
			{@const width = ((Math.abs(factor.difference ?? 0) / scale) * 50).toFixed(1)}
			<li class={cn('grid items-center gap-3 py-2', COLUMNS)}>
				<div class="min-w-0">
					<p class="truncate text-sm font-medium">{factor.note ?? m.factor_trained()}</p>
					<p class="text-xs text-muted-foreground tabular-nums">
						{m.factor_meta({
							nights: m.nights_count({ count: factor.nights }),
							average: Math.round(factor.average)
						})}
					</p>
				</div>
				<!-- Diverging from the centre: worse to the left, better to the right. -->
				<div class="relative h-3" aria-hidden="true">
					<span class="absolute inset-y-0 left-1/2 w-px bg-border"></span>
					{#if factor.difference !== null}
						<span
							class={cn(
								'absolute inset-y-0 rounded-sm',
								!factor.clear
									? 'bg-muted-foreground/30'
									: factor.difference > 0
										? 'bg-emerald-500'
										: 'bg-red-500'
							)}
							style:left={factor.difference > 0 ? '50%' : undefined}
							style:right={factor.difference < 0 ? '50%' : undefined}
							style:width="{width}%"
						></span>
					{/if}
				</div>
				<span
					class={cn(
						'text-right text-sm font-medium tabular-nums',
						factor.difference === null || !factor.clear
							? 'text-muted-foreground'
							: factor.difference > 0
								? 'text-emerald-700 dark:text-emerald-400'
								: 'text-red-700 dark:text-red-400'
					)}
				>
					{factor.difference === null ? '—' : formatSigned(factor.difference, 1)}
				</span>
			</li>
		{/each}
	</ul>
	<p class="mt-2 text-xs text-muted-foreground">{m.notes_impact_footnote()}</p>
</section>
