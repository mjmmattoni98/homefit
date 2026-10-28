<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import LanguageSwitcher from '#lib/components/LanguageSwitcher.svelte';
	import LanguageMenu from '#lib/components/LanguageMenu.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import UserMenu from '#lib/components/UserMenu.svelte';
	import type { Snippet } from 'svelte';

	let { leading }: { leading?: Snippet } = $props();

	const user = $derived(page.data.user);
</script>

<header class="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
	<div class="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2">
		<div class="flex items-center gap-2">
			{@render leading?.()}
			<a href={resolve('/')} class="text-lg font-semibold tracking-tight">
				{m.app_name()}
			</a>
		</div>
		<nav class="ml-auto flex flex-wrap items-center justify-end gap-2">
			<ThemeToggle />
			<div class="sm:hidden"><LanguageMenu side="bottom" /></div>
			<div class="hidden sm:block"><LanguageSwitcher /></div>
			{#if user}
				<UserMenu {user} />
			{:else}
				<a href={resolve('sign-in')} class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
					{m.sign_in()}
				</a>
				{#if page.data.signupEnabled}
					<a href={resolve('sign-up')} class={buttonVariants({ size: 'sm' })}>
						{m.sign_up()}
					</a>
				{/if}
			{/if}
		</nav>
	</div>
</header>
