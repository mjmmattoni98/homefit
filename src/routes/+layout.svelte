<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { locales, localizeHref } from '$lib/paraglide/runtime';
	import { ClerkProvider, Show, SignInButton, SignUpButton, UserButton } from 'svelte-clerk';
	import { shadcn } from '@clerk/ui/themes';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<ClerkProvider appearance={{ theme: shadcn }}>
	<header class="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
		<div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
			<a href={resolve(localizeHref('/') as Pathname)} class="text-lg font-semibold tracking-tight">HomeFit</a>
			<nav class="flex items-center gap-2">
				<Show when="signed-out">
					<SignInButton
						mode="modal"
						class="px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
					/>
					<SignUpButton
						mode="modal"
						class="bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
					/>
				</Show>
				<Show when="signed-in">
					<UserButton />
				</Show>
			</nav>
		</div>
	</header>

	{@render children()}
</ClerkProvider>

<div style="display:none">
	{#each locales as locale (locale)}
		<a
			href={resolve(localizeHref(page.url.pathname, { locale }) as Pathname)}
		>{locale}</a>
	{/each}
</div>
