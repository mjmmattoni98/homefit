<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button, buttonVariants } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { MAX_AMOUNT } from '#lib/daily-goals.js';
	import type { GoalSettingsItem } from '#lib/server/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import { unitLabel } from './labels.js';

	let {
		goal,
		first,
		last,
		pending = false,
		onsave,
		onmove,
		onarchive
	}: {
		goal: GoalSettingsItem;
		first: boolean;
		last: boolean;
		pending?: boolean;
		onsave: (changes: { name?: string; target?: number }) => void;
		onmove: (offset: -1 | 1) => void;
		onarchive: () => void;
	} = $props();

	// Editable copies that reset whenever the saved goal changes.
	let name = $derived(goal.name);
	let target = $derived<number | null>(goal.target);

	const trimmed = $derived(name.trim());
	const valid = $derived(
		trimmed.length >= 1 &&
			trimmed.length <= 100 &&
			target !== null &&
			Number.isInteger(target) &&
			target >= 1 &&
			target <= MAX_AMOUNT
	);
	const dirty = $derived(trimmed !== goal.name || target !== goal.target);

	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!valid || !dirty || target === null) return;
		onsave({
			...(trimmed !== goal.name ? { name: trimmed } : {}),
			...(target !== goal.target ? { target } : {})
		});
	}
</script>

<li class="flex flex-col gap-2 border-t border-rule pt-3">
	<form class="flex flex-wrap items-end gap-2" onsubmit={save}>
		<label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-ink-3">
			{m.goals_name()}
			<Input bind:value={name} maxlength={100} class="h-9" />
		</label>
		<label class="flex w-28 flex-col gap-1 text-xs text-ink-3">
			{m.goals_target()} ({unitLabel(goal.unit)})
			<Input type="number" min="1" max={MAX_AMOUNT} step="1" bind:value={target} class="h-9" />
		</label>
		{#if dirty}
			<Button type="submit" size="sm" class="h-9" disabled={pending || !valid}>
				{m.goals_save()}
			</Button>
		{/if}
	</form>
	<div class="flex items-center gap-1">
		<Button
			variant="ghost"
			size="icon-sm"
			disabled={pending || first}
			aria-label={m.goals_move_up({ name: goal.name })}
			onclick={() => onmove(-1)}
		>
			<ArrowUpIcon />
		</Button>
		<Button
			variant="ghost"
			size="icon-sm"
			disabled={pending || last}
			aria-label={m.goals_move_down({ name: goal.name })}
			onclick={() => onmove(1)}
		>
			<ArrowDownIcon />
		</Button>
		<AlertDialog.Root>
			<AlertDialog.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'sm', class: 'ml-auto' })}
				disabled={pending}
			>
				{m.goals_archive()}
			</AlertDialog.Trigger>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Title>{m.goals_archive_title({ name: goal.name })}</AlertDialog.Title>
					<AlertDialog.Description>{m.goals_archive_desc()}</AlertDialog.Description>
				</AlertDialog.Header>
				<AlertDialog.Footer>
					<AlertDialog.Cancel>{m.goals_cancel()}</AlertDialog.Cancel>
					<AlertDialog.Action onclick={onarchive}>{m.goals_archive()}</AlertDialog.Action>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	</div>
</li>
