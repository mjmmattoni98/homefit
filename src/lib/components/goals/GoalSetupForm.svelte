<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MAX_AMOUNT, WORKWEEK_MASK, type GoalUnit, type NewGoal } from '#lib/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import XIcon from '@lucide/svelte/icons/x';
	import WeekdayPicker from './WeekdayPicker.svelte';
	import { unitLabel, unitName } from './labels.js';

	let {
		pending = false,
		onsave
	}: {
		pending?: boolean;
		onsave: (goals: NewGoal[], weekdays: number) => void;
	} = $props();

	let nextKey = 3;
	let drafts = $state<{ key: number; name: string; unit: GoalUnit; target: number | null }[]>([
		{ key: 0, name: m.goals_suggest_walking(), unit: 'minutes', target: 60 },
		{ key: 1, name: m.goals_suggest_pushups(), unit: 'reps', target: 100 },
		{ key: 2, name: m.goals_suggest_plank(), unit: 'seconds', target: 120 }
	]);
	let weekdays = $state(WORKWEEK_MASK);

	const valid = $derived(
		drafts.length > 0 &&
			drafts.every(
				(draft) =>
					draft.name.trim().length >= 1 &&
					draft.name.trim().length <= 100 &&
					draft.target !== null &&
					Number.isInteger(draft.target) &&
					draft.target >= 1 &&
					draft.target <= MAX_AMOUNT
			)
	);

	function addDraft(unit: GoalUnit) {
		drafts.push({ key: nextKey++, name: '', unit, target: null });
	}

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!valid) return;
		onsave(
			drafts.map((draft) => ({
				name: draft.name.trim(),
				unit: draft.unit,
				target: draft.target ?? 0
			})),
			weekdays
		);
	}
</script>

<form class="flex flex-col gap-6" onsubmit={save}>
	<p class="text-sm text-ink-2">{m.goals_setup_intro()}</p>
	<ul class="flex flex-col gap-3">
		{#each drafts as draft, index (draft.key)}
			<li class="flex items-end gap-2">
				<label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-3">
					{m.goals_name()}
					<Input bind:value={draft.name} maxlength={100} class="h-9" />
				</label>
				<label class="flex w-28 flex-col gap-1 text-xs text-ink-3">
					{m.goals_target()} ({unitLabel(draft.unit)})
					<Input
						type="number"
						min="1"
						max={MAX_AMOUNT}
						step="1"
						bind:value={draft.target}
						class="h-9"
					/>
				</label>
				<Button
					variant="ghost"
					size="icon"
					aria-label={m.goals_remove_named({ name: draft.name || unitName(draft.unit) })}
					onclick={() => drafts.splice(index, 1)}
				>
					<XIcon />
				</Button>
			</li>
		{/each}
	</ul>
	<div class="flex flex-wrap items-center gap-2 text-sm text-ink-3">
		{m.goals_add_goal()}:
		<Button variant="outline" size="sm" onclick={() => addDraft('minutes')}>
			{unitName('minutes')}
		</Button>
		<Button variant="outline" size="sm" onclick={() => addDraft('reps')}>
			{unitName('reps')}
		</Button>
		<Button variant="outline" size="sm" onclick={() => addDraft('seconds')}>
			{unitName('seconds')}
		</Button>
	</div>
	<div class="flex flex-col gap-2">
		<p class="text-sm text-ink-2">{m.goals_days_label()}</p>
		<WeekdayPicker
			value={weekdays}
			label={m.goals_days_label()}
			onchange={(mask) => (weekdays = mask)}
		/>
		<p class="text-xs text-ink-3">{m.goals_days_hint()}</p>
	</div>
	<Button type="submit" disabled={pending || !valid}>{m.goals_setup_save()}</Button>
</form>
