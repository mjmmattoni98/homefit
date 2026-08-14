<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { Show, SignInButton, SignUpButton, UserButton } from 'svelte-clerk';
	import * as m from '$lib/paraglide/messages';
	import { buttonVariants } from '$lib/components/ui/button';
	import LanguageSwitcher from '$lib/components/LanguageSwitcher.svelte';
	import type { Snippet } from 'svelte';

	let { leading }: { leading?: Snippet } = $props();
</script>

<header class="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
	<div class="flex h-14 items-center justify-between gap-2 px-4">
		<div class="flex items-center gap-2">
			{@render leading?.()}
			<a href={resolve('/' as Pathname)} class="text-lg font-semibold tracking-tight">
				{m.app_name()}
			</a>
		</div>
		<nav class="flex items-center gap-2">
			<LanguageSwitcher />
			<Show when="signed-out">
				<SignInButton mode="modal" class={buttonVariants({ variant: 'ghost', size: 'sm' })}>
					{m.sign_in()}
				</SignInButton>
				<SignUpButton mode="modal" class={buttonVariants({ size: 'sm' })}>
					{m.sign_up()}
				</SignUpButton>
			</Show>
			<Show when="signed-in">
				<UserButton />
			</Show>
		</nav>
	</div>
</header>
