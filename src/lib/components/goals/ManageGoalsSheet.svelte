<script lang="ts">
	import { toast } from 'svelte-sonner';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import type { NewGoal } from '#lib/daily-goals.js';
	import {
		archiveGoal,
		createGoal,
		getGoalDay,
		getGoalHistory,
		getGoals,
		reorderGoals,
		setSchedule,
		updateGoal
	} from '#lib/remote/goals.remote.js';
	import type { GoalSettings } from '#lib/server/daily-goals.js';
	import * as m from '#lib/paraglide/messages.js';
	import AddGoalForm from './AddGoalForm.svelte';
	import GoalSettingsRow from './GoalSettingsRow.svelte';
	import GoalSetupForm from './GoalSetupForm.svelte';
	import WeekdayPicker from './WeekdayPicker.svelte';

	let { settings, open = $bindable(false) }: { settings: GoalSettings; open?: boolean } = $props();

	let pending = $state(false);

	/** Runs one or more writes, refreshing every goal view on the page; false when it failed. */
	async function run(work: () => Promise<unknown>): Promise<boolean> {
		pending = true;
		try {
			await work();
			return true;
		} catch {
			toast.error(m.goals_action_error());
			return false;
		} finally {
			pending = false;
		}
	}

	const views = [getGoalDay, getGoalHistory, getGoals] as const;

	function move(index: number, offset: -1 | 1) {
		const ids = settings.goals.map((goal) => goal.id);
		[ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
		void run(() => reorderGoals(ids).updates(...views));
	}

	function setUp(goals: NewGoal[], weekdays: number) {
		void run(async () => {
			await setSchedule(weekdays).updates(...views);
			for (const goal of goals) await createGoal(goal).updates(...views);
		}).then((saved) => {
			if (saved) open = false;
		});
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="w-full gap-0 overflow-y-auto bg-day sm:max-w-md">
		<Sheet.Header class="border-b border-rule">
			<Sheet.Title>{m.goals_manage()}</Sheet.Title>
			<Sheet.Description>{m.goals_manage_desc()}</Sheet.Description>
		</Sheet.Header>
		<div class="flex flex-col gap-10 p-4">
			{#if settings.goals.length === 0}
				<GoalSetupForm {pending} onsave={setUp} />
			{:else}
				<section class="flex flex-col gap-2" aria-labelledby="goal-days-title">
					<h3 id="goal-days-title" class="text-lg">{m.goals_days_label()}</h3>
					<WeekdayPicker
						value={settings.weekdays ?? 0}
						label={m.goals_days_label()}
						disabled={pending}
						onchange={(mask) => void run(() => setSchedule(mask).updates(...views))}
					/>
					<p class="text-xs text-ink-3">{m.goals_days_hint()}</p>
				</section>

				<section class="flex flex-col gap-2" aria-labelledby="goal-list-title">
					<h3 id="goal-list-title" class="text-lg">{m.goals_list_title()}</h3>
					<ul class="flex flex-col gap-3">
						{#each settings.goals as goal, index (goal.id)}
							<GoalSettingsRow
								{goal}
								{pending}
								first={index === 0}
								last={index === settings.goals.length - 1}
								onsave={(changes) =>
									void run(() => updateGoal({ goalId: goal.id, ...changes }).updates(...views))}
								onmove={(offset) => move(index, offset)}
								onarchive={() => void run(() => archiveGoal(goal.id).updates(...views))}
							/>
						{/each}
					</ul>
				</section>

				<section class="flex flex-col gap-3" aria-labelledby="goal-add-title">
					<h3 id="goal-add-title" class="text-lg">{m.goals_add_goal()}</h3>
					<AddGoalForm {pending} onadd={(goal) => run(() => createGoal(goal).updates(...views))} />
				</section>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>
