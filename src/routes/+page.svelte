<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import ChartLineIcon from '@lucide/svelte/icons/chart-line';
</script>

<svelte:head>
	<title>{m.app_name()} · {m.landing_title()}</title>
	<meta name="description" content={m.landing_subtitle()} />
</svelte:head>

<SiteHeader />

<main class="mx-auto max-w-5xl px-4">
	<section class="flex flex-col items-center gap-6 py-20 text-center">
		<h1 class="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
			{m.landing_title()}
		</h1>
		<p class="max-w-xl text-lg text-muted-foreground">
			{m.landing_subtitle()}
		</p>
		<!-- Signed-in visitors are sent to the dashboard by the page's server load. -->
		<div class="flex flex-wrap justify-center gap-2">
			<a href={resolve('sign-in')} class={buttonVariants({ size: 'lg' })}>{m.landing_signin()}</a>
			{#if page.data.signupEnabled}
				<a href={resolve('sign-up')} class={buttonVariants({ size: 'lg', variant: 'outline' })}>
					{m.sign_up()}
				</a>
			{/if}
		</div>
	</section>

	<section class="grid gap-4 pb-20 sm:grid-cols-3">
		<Card.Root>
			<Card.Header>
				<div
					class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
				>
					<MoonIcon class="size-5" />
				</div>
				<Card.Title>{m.landing_feature_sleep_title()}</Card.Title>
				<Card.Description>{m.landing_feature_sleep_desc()}</Card.Description>
			</Card.Header>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<div
					class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
				>
					<DumbbellIcon class="size-5" />
				</div>
				<Card.Title>{m.landing_feature_training_title()}</Card.Title>
				<Card.Description>{m.landing_feature_training_desc()}</Card.Description>
			</Card.Header>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<div
					class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
				>
					<ChartLineIcon class="size-5" />
				</div>
				<Card.Title>{m.landing_feature_correlations_title()}</Card.Title>
				<Card.Description>{m.landing_feature_correlations_desc()}</Card.Description>
			</Card.Header>
		</Card.Root>
	</section>
</main>
