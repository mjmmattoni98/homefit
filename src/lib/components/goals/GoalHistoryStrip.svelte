<script lang="ts">
	import { resolve } from '$app/paths';
	import { weekdayIndex, type HistoryDay } from '#lib/daily-goals.js';
	import { dayToDate } from '#lib/days.js';
	import { formatDate } from '#lib/format.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import { historyDayLabel } from './labels.js';

	let {
		days,
		today,
		selected
	}: {
		/** Consecutive days, oldest first, ending today. */
		days: readonly HistoryDay[];
		today: string;
		selected: string;
	} = $props();

	// One column per Monday-based week, one row per weekday; blank cells pad the first week.
	const padding = $derived(days.length === 0 ? 0 : weekdayIndex(days[0].day));

	const href = (day: string) =>
		day === today ? resolve('/dashboard/today') : resolve('/dashboard/today/[day]', { day });

	function cellClass(day: HistoryDay): string {
		if (day.status === 'done') return 'bg-sun';
		if (day.status === 'in-progress') return 'border-2 border-sun';
		if (day.status === 'missed') return 'bg-error/30';
		return day.allMet ? 'bg-day-3 ring-2 ring-sun/60 ring-inset' : 'bg-day-2';
	}

	const legend = $derived([
		{ className: 'bg-sun', label: m.goals_status_done() },
		{ className: 'bg-error/30', label: m.goals_status_missed() },
		{ className: 'bg-day-2', label: m.goals_status_rest() },
		{ className: 'bg-day-3 ring-2 ring-sun/60 ring-inset', label: m.goals_status_rest_met() }
	]);
</script>

<div class="flex flex-col gap-3">
	<div class="grid w-max grid-flow-col grid-rows-7 gap-1">
		{#each { length: padding }, index (index)}
			<span class="size-4 sm:size-5" aria-hidden="true"></span>
		{/each}
		{#each days as day (day.day)}
			<a
				href={href(day.day)}
				class={cn(
					'size-4 rounded-[2px] outline-offset-2 sm:size-5',
					cellClass(day),
					day.day === selected && 'outline-2 outline-foreground'
				)}
				aria-current={day.day === selected ? 'date' : undefined}
				aria-label={`${formatDate(dayToDate(day.day).getTime(), { weekday: 'short', day: 'numeric', month: 'short' })}: ${historyDayLabel(day)}`}
			></a>
		{/each}
	</div>
	<ul class="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-3">
		{#each legend as item (item.label)}
			<li class="flex items-center gap-1.5">
				<span class={cn('size-3 rounded-[2px]', item.className)} aria-hidden="true"></span>
				{item.label}
			</li>
		{/each}
	</ul>
</div>
