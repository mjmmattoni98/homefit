<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { Show, SignInButton } from 'svelte-clerk';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';
</script>

<SiteHeader />

<main class="mx-auto max-w-5xl px-4">
	<section class="flex flex-col items-center gap-6 py-20 text-center">
		<h1 class="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
			{m.landing_title()}
		</h1>
		<p class="max-w-xl text-lg text-muted-foreground">
			{m.landing_subtitle()}
		</p>
		<Show when="signed-in">
			<a href={resolve('/dashboard' as Pathname)} class={buttonVariants({ size: 'lg' })}>
				{m.landing_cta()}
			</a>
		</Show>
		<Show when="signed-out">
			<SignInButton mode="modal" class={buttonVariants({ size: 'lg' })}>
				{m.landing_signin()}
			</SignInButton>
		</Show>
	</section>

	<section class="grid gap-4 pb-20 sm:grid-cols-3">
		<Card.Root>
			<Card.Header>
				<div class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<MoonIcon class="size-5" />
				</div>
				<Card.Title>{m.landing_feature_sleep_title()}</Card.Title>
				<Card.Description>{m.landing_feature_sleep_desc()}</Card.Description>
			</Card.Header>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<div class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<DumbbellIcon class="size-5" />
				</div>
				<Card.Title>{m.landing_feature_training_title()}</Card.Title>
				<Card.Description>{m.landing_feature_training_desc()}</Card.Description>
			</Card.Header>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<div class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
					<ChartLineIcon class="size-5" />
				</div>
				<Card.Title>{m.landing_feature_correlations_title()}</Card.Title>
				<Card.Description>{m.landing_feature_correlations_desc()}</Card.Description>
			</Card.Header>
		</Card.Root>
	</section>
</main>
