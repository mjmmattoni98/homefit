<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import LanguageSwitcher from '#lib/components/LanguageSwitcher.svelte';
	import LanguageMenu from '#lib/components/LanguageMenu.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import UserMenu from '#lib/components/UserMenu.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';
	import type { Snippet } from 'svelte';

	let { leading }: { leading?: Snippet } = $props();

	const user = $derived(page.data.user);
</script>

<!-- The same bar as the app's: the wordmark on the left, the way in on the right. -->
<header class="sticky top-0 z-40 border-b border-rule bg-day">
	<div
		class="mx-auto flex min-h-(--bar-height) w-full max-w-(--container) flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 py-2 md:px-8"
	>
		<div class="flex items-center gap-2">
			{@render leading?.()}
			<a href={resolve('/')} class="flex items-center" aria-label={m.app_name()}>
				<Wordmark />
			</a>
		</div>
		<nav class="ml-auto flex flex-wrap items-center justify-end gap-1">
			<ThemeToggle />
			<div class="sm:hidden"><LanguageMenu side="bottom" /></div>
			<div class="mr-2 hidden sm:block"><LanguageSwitcher /></div>
			{#if user}
				<UserMenu {user} />
			{:else}
				<a href={resolve('sign-in')} class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
					{m.sign_in()}
				</a>
				{#if page.data.signupEnabled}
					<a href={resolve('sign-up')} class={buttonVariants({ variant: 'outline', size: 'sm' })}>
						{m.sign_up()}
					</a>
				{/if}
			{/if}
		</nav>
	</div>
</header>
