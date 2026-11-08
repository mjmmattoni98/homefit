<script lang="ts">
	import { resolve } from '$app/paths';
	import { getGoalDay, getGoalHistory } from '#lib/remote/goals.remote.js';
	import { formatNumber } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';

	// Created only once the page knows the time zone cookie is set (see the overview page).
	const dayQuery = getGoalDay(null);
	const historyQuery = getGoalHistory();

	const goalDay = $derived(dayQuery.current);
	const history = $derived(historyQuery.current);
	const done = $derived(goalDay?.goals.filter((goal) => goal.met).length ?? 0);
</script>

{#if goalDay !== undefined && history !== undefined}
	<a
		href={resolve('/dashboard/today')}
		class="group flex flex-wrap items-baseline gap-x-5 gap-y-1 border-y border-rule py-3 text-sm text-ink-2 hover:text-foreground"
	>
		<span class="text-base font-medium text-foreground">{m.goals_card_title()}</span>
		{#if goalDay.goals.length === 0}
			<span>{m.goals_card_setup()}</span>
		{:else}
			<span class="tabular-nums">
				{m.goals_card_done({ done: formatNumber(done), total: formatNumber(goalDay.goals.length) })}
			</span>
			<span class="tabular-nums">
				{m.goals_streak_short({ count: formatNumber(history.currentStreak) })}
			</span>
		{/if}
		<ArrowRightIcon
			class="ml-auto size-4 self-center transition-transform duration-(--dur-micro) group-hover:translate-x-0.5"
			aria-hidden="true"
		/>
	</a>
{/if}
