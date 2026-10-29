<script lang="ts">
	import { toggleMode } from 'mode-watcher';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import SunIcon from '@lucide/svelte/icons/sun';
</script>

<!-- The icon follows the `dark` class, so server-rendered markup matches whichever mode loads. -->
<Button variant="ghost" size="icon" class="relative" onclick={toggleMode} title={m.theme_toggle()}>
	<SunIcon
		class="scale-100 rotate-0 transition-transform duration-(--dur-short) ease-out motion-reduce:transition-none dark:scale-0 dark:-rotate-90"
	/>
	<MoonIcon
		class="absolute scale-0 rotate-90 transition-transform duration-(--dur-short) ease-out motion-reduce:transition-none dark:scale-100 dark:rotate-0"
	/>
	<span class="sr-only">{m.theme_toggle()}</span>
</Button>
