<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { MAX_AMOUNT, QUICK_AMOUNTS } from '#lib/daily-goals.js';
	import type { GoalProgress } from '#lib/server/daily-goals.js';
	import { formatNumber } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import { unitLabel } from './labels.js';

	let {
		goal,
		pending = false,
		onadd,
		onundo
	}: {
		goal: GoalProgress;
		/** Disables every action while a write for this goal is in flight. */
		pending?: boolean;
		onadd: (amount: number) => void;
		onundo: () => void;
	} = $props();

	let custom = $state<number | null>(null);
	const customValid = $derived(
		custom !== null && Number.isInteger(custom) && custom >= 1 && custom <= MAX_AMOUNT
	);
	const unit = $derived(unitLabel(goal.unit));

	function addCustom(event: SubmitEvent) {
		event.preventDefault();
		if (custom === null || !customValid) return;
		onadd(custom);
		custom = null;
	}
</script>

<article class="flex flex-col gap-4 border-t border-rule pt-5" aria-labelledby="goal-{goal.id}">
	<header class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
		<h3 id="goal-{goal.id}" class="flex items-center gap-2 text-xl">
			{goal.name}
			{#if goal.met}
				<CheckIcon class="size-5 text-success" aria-hidden="true" />
				<span class="sr-only">{m.goals_met()}</span>
			{/if}
		</h3>
		<p class="text-sm text-ink-2 tabular-nums">
			{m.goals_progress({
				total: formatNumber(goal.total),
				target: formatNumber(goal.target),
				unit
			})}
		</p>
	</header>
	<Progress
		value={Math.min(goal.total, goal.target)}
		max={goal.target}
		class="h-2"
		aria-label={goal.name}
	/>
	<div class="flex flex-wrap items-center gap-2">
		{#each QUICK_AMOUNTS[goal.unit] as amount (amount)}
			<Button variant="outline" size="sm" disabled={pending} onclick={() => onadd(amount)}>
				+{formatNumber(amount)}
				{unit}
			</Button>
		{/each}
		<form class="flex items-center gap-2" onsubmit={addCustom}>
			<Input
				type="number"
				inputmode="numeric"
				min="1"
				max={MAX_AMOUNT}
				step="1"
				placeholder={unit}
				aria-label={m.goals_custom_amount({ name: goal.name })}
				class="h-8 w-24"
				bind:value={custom}
			/>
			<Button type="submit" variant="secondary" size="sm" disabled={pending || !customValid}>
				{m.goals_add()}
			</Button>
		</form>
		<Button
			variant="ghost"
			size="sm"
			class="ml-auto"
			disabled={pending || goal.entries.length === 0}
			onclick={onundo}
		>
			<Undo2Icon aria-hidden="true" />
			{m.goals_undo()}
		</Button>
	</div>
</article>
