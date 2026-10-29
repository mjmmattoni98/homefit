<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';

	let { class: className }: { class?: string } = $props();
</script>

<!-- The name in the figure cut, so it matches the numbers it sits above. -->
<span class={cn('text-[1.375rem] leading-none font-figure tracking-[-0.01em]', className)}>
	{m.app_name()}
</span>
