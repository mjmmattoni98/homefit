<script lang="ts">
	import { Show, SignInButton } from 'svelte-clerk';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<Show when="signed-in">
	{@render children()}
</Show>
<Show when="signed-out">
	<div class="flex flex-col items-center justify-center gap-4 px-4 py-24 text-center">
		<h2 class="text-xl font-semibold">{m.auth_required_title()}</h2>
		<p class="max-w-sm text-muted-foreground">{m.auth_required_desc()}</p>
		<SignInButton mode="modal" class={buttonVariants()}>
			{m.sign_in()}
		</SignInButton>
	</div>
</Show>
