<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { GOAL_UNITS, MAX_AMOUNT, type GoalUnit, type NewGoal } from '#lib/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import { unitName } from './labels.js';

	let {
		pending = false,
		onadd
	}: {
		pending?: boolean;
		/** Resolves true when the goal was saved, which clears the form. */
		onadd: (goal: NewGoal) => Promise<boolean>;
	} = $props();

	let name = $state('');
	let unit = $state<GoalUnit>('reps');
	let target = $state<number | null>(null);

	const trimmed = $derived(name.trim());
	const valid = $derived(
		trimmed.length >= 1 &&
			trimmed.length <= 100 &&
			target !== null &&
			Number.isInteger(target) &&
			target >= 1 &&
			target <= MAX_AMOUNT
	);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!valid || target === null) return;
		if (await onadd({ name: trimmed, unit, target })) {
			name = '';
			target = null;
		}
	}
</script>

<form class="flex flex-col gap-3" onsubmit={submit}>
	<label class="flex flex-col gap-1 text-xs text-ink-3">
		{m.goals_name()}
		<Input bind:value={name} maxlength={100} class="h-9" />
	</label>
	<div class="flex flex-col gap-1 text-xs text-ink-3">
		<span id="new-goal-unit">{m.goals_unit()}</span>
		<div class="flex gap-1.5" role="group" aria-labelledby="new-goal-unit">
			{#each GOAL_UNITS as option (option)}
				<button
					type="button"
					class={cn(
						'h-9 flex-1 rounded-(--radius-control) border text-sm transition-colors duration-(--dur-micro)',
						unit === option
							? 'border-sun bg-sun text-white'
							: 'border-rule-2 text-ink-2 hover:border-field-edge hover:text-foreground'
					)}
					aria-pressed={unit === option}
					onclick={() => (unit = option)}
				>
					{unitName(option)}
				</button>
			{/each}
		</div>
	</div>
	<label class="flex flex-col gap-1 text-xs text-ink-3">
		{m.goals_target()}
		<Input type="number" min="1" max={MAX_AMOUNT} step="1" bind:value={target} class="h-9" />
	</label>
	<Button type="submit" disabled={pending || !valid}>{m.goals_add_goal()}</Button>
</form>
