<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils.js';
	import type { HTMLThAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLThAttributes> = $props();
</script>

<th
	bind:this={ref}
	data-slot="table-head"
	class={cn(
		'h-9 px-2 text-left align-middle text-[0.8125rem] font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</th>
