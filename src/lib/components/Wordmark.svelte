<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import logo from '#lib/assets/homefit-logo.png';

	let { class: className }: { class?: string } = $props();
</script>

<!-- Keep the symbol decorative: the adjacent name labels the brand. -->
<span
	class={cn(
		'inline-flex shrink-0 items-center gap-2 text-[1.375rem] leading-none font-figure tracking-[-0.01em]',
		className
	)}
>
	<img src={logo} alt="" width="32" height="32" class="size-8 shrink-0" />
	{m.app_name()}
</span>
