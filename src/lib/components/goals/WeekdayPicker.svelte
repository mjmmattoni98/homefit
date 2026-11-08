<script lang="ts">
	import { dayFromNumber, dayNumber, dayToDate } from '#lib/days.js';
	import { formatDate } from '#lib/format.js';
	import { cn } from '#lib/utils.js';

	let {
		value,
		label,
		disabled = false,
		onchange
	}: {
		/** Weekday mask, bit 0 = Monday … bit 6 = Sunday. */
		value: number;
		label: string;
		disabled?: boolean;
		onchange: (mask: number) => void;
	} = $props();

	// 2026-11-02 is a Monday; naming the week from a real date keeps the labels in the UI locale.
	const MONDAY = dayNumber('2026-11-02');
	const names = Array.from({ length: 7 }, (_, index) => {
		const date = dayToDate(dayFromNumber(MONDAY + index)).getTime();
		return {
			index,
			short: formatDate(date, { weekday: 'narrow' }),
			long: formatDate(date, { weekday: 'long' })
		};
	});

	function toggle(index: number) {
		const next = value ^ (1 << index);
		// At least one day must count.
		if (next !== 0) onchange(next);
	}
</script>

<div class="flex gap-1.5" role="group" aria-label={label}>
	{#each names as day (day.index)}
		{@const on = (value & (1 << day.index)) !== 0}
		<button
			type="button"
			class={cn(
				'flex size-10 items-center justify-center rounded-(--radius-control) border text-sm transition-colors duration-(--dur-micro) disabled:opacity-55',
				on
					? 'border-sun bg-sun text-white'
					: 'border-rule-2 text-ink-2 hover:border-field-edge hover:text-foreground'
			)}
			aria-pressed={on}
			aria-label={day.long}
			{disabled}
			onclick={() => toggle(day.index)}
		>
			{day.short}
		</button>
	{/each}
</div>
