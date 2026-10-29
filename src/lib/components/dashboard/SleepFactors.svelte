<script lang="ts">
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import { formatSigned } from '#lib/format.js';
	import { FACTOR_TARGETS, type SleepFactor, type SleepFactorTarget } from '#lib/overview.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';

	let {
		factors,
		description,
		target = 'quality',
		ontargetchange
	}: {
		factors: SleepFactor[];
		description: string;
		target?: SleepFactorTarget;
		ontargetchange?: (next: SleepFactorTarget) => void;
	} = $props();

	const targetLabels: Record<SleepFactorTarget, () => string> = {
		quality: () => m.factor_target_quality(),
		latency: () => m.factor_target_latency(),
		snore: () => m.factor_target_snore(),
		movements: () => m.factor_target_movements()
	};

	const minScale = $derived(target === 'movements' ? 2 : 5);
	const scale = $derived(
		Math.max(
			minScale,
			...factors.map((factor) => Math.abs(factor.improvement ?? factor.difference ?? 0))
		)
	);
	const COLUMNS = 'grid-cols-[minmax(0,1fr)_6rem_4rem] sm:grid-cols-[minmax(0,1fr)_10rem_4rem]';

	const diffHeader = $derived.by(() => {
		if (target === 'quality') return m.factors_col_difference();
		if (target === 'movements') return m.factors_col_diff_mov();
		return m.factors_col_diff_min();
	});

	function factorTitle(factor: SleepFactor): string {
		if (factor.kind === 'heavy_training') return m.factor_heavy_training();
		if (factor.kind === 'late_workout') return m.factor_late_workout();
		if (factor.kind === 'away_city') return m.factor_away_generic();
		if (factor.note === null || factor.kind === 'training') return m.factor_trained();
		return factor.note;
	}

	function factorMeta(factor: SleepFactor): string {
		const nights = m.nights_count({ count: factor.nights });
		if (target === 'quality') {
			return m.factor_meta({ nights, average: Math.round(factor.average) });
		}
		if (target === 'movements') {
			return m.factor_meta_mov({ nights, average: factor.average.toFixed(1) });
		}
		return m.factor_meta_min({ nights, average: Math.round(factor.average) });
	}
</script>

<!-- A piece of the night field: every factor here is measured on the nights. -->
<section
	class="min-w-0 bg-night px-5 pt-6 pb-5 text-moon sm:px-7"
	aria-labelledby="sleep-factors-title"
>
	<div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
		<div class="min-w-0">
			<h2 id="sleep-factors-title" class="text-2xl">{m.factors_title()}</h2>
			<p class="mt-2 text-sm text-moon-2">{description}</p>
		</div>
	</div>

	{#if ontargetchange}
		<ToggleGroup.Root
			type="single"
			bind:value={
				() => target,
				(next) => {
					if (next) ontargetchange(next as SleepFactorTarget);
				}
			}
			variant="outline"
			aria-label={m.factor_target_label()}
			class="mt-4 w-full border-night-rule data-[variant=outline]:shadow-none sm:w-auto"
		>
			{#each FACTOR_TARGETS as option (option)}
				<ToggleGroup.Item
					value={option}
					class="h-8 flex-1 border-night-rule px-2.5 text-xs text-moon-2 hover:bg-night-2 hover:text-moon data-[state=on]:bg-night-2 data-[state=on]:text-moon sm:flex-none"
				>
					{targetLabels[option]()}
				</ToggleGroup.Item>
			{/each}
		</ToggleGroup.Root>
	{/if}

	<div
		class={cn('mt-6 grid gap-3 border-b border-night-rule pb-2 text-sm text-moon-2', COLUMNS)}
		aria-hidden="true"
	>
		<span>{m.factors_col_factor()}</span>
		<span class="flex justify-between">
			<span>{m.factors_worse()}</span><span>{m.factors_better()}</span>
		</span>
		<span class="text-right">{diffHeader}</span>
	</div>
	<ul class="divide-y divide-night-rule">
		{#each factors as factor (factor.note ?? '__trained__')}
			{@const dir = factor.improvement ?? factor.difference}
			{@const width = ((Math.abs(dir ?? 0) / scale) * 50).toFixed(1)}
			<li class={cn('grid items-center gap-3 py-3', COLUMNS)}>
				<div class="min-w-0">
					<p class="truncate font-medium">{factorTitle(factor)}</p>
					<p class="text-sm text-moon-2">{factorMeta(factor)}</p>
				</div>
				<!-- Diverging from the centre: worse to the left, better to the right. -->
				<div class="relative h-3" aria-hidden="true">
					<span class="absolute -inset-y-1.5 left-1/2 w-px bg-moon-2/60"></span>
					{#if dir !== null}
						<span
							class={cn('absolute inset-y-0', factor.clear ? 'bg-sleep' : 'bg-moon-2/40')}
							style:left={dir > 0 ? '50%' : undefined}
							style:right={dir < 0 ? '50%' : undefined}
							style:width="{width}%"
						></span>
					{/if}
				</div>
				<span
					class={cn(
						'text-right',
						factor.difference === null || !factor.clear ? 'text-moon-2' : 'font-medium text-moon'
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
