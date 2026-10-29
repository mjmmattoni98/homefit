<script lang="ts">
	import { splitUnit } from '#lib/format.js';
	import { cn } from '#lib/utils.js';

	// A figure with its unit set apart and smaller, so "126,868 kg" stays on one line and the
	// digits carry the weight.
	let {
		value,
		class: className,
		numberClass,
		unitClass = 'ml-[0.25em] text-[0.55em] font-medium tracking-normal text-muted-foreground'
	}: { value: string; class?: string; numberClass?: string; unitClass?: string } = $props();

	const parts = $derived(splitUnit(value));
</script>

<span class={cn('whitespace-nowrap', className)}
	><span class={numberClass}>{parts.number}</span>{#if parts.unit}<span class={unitClass}
			>{parts.unit}</span
		>{/if}</span
>
