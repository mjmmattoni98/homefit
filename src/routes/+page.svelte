<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import SiteHeader from '#lib/components/SiteHeader.svelte';

	// The title breaks after its comma ("Your sleep and training, / in one dashboard"), in every
	// language that has one, so no line ends on a stub.
	const titleLines = $derived(m.landing_title().split(/(?<=,)\s+/));

	const training = $derived({
		title: m.landing_feature_training_title(),
		description: m.landing_feature_training_desc()
	});
	const sleep = $derived({
		title: m.landing_feature_sleep_title(),
		description: m.landing_feature_sleep_desc()
	});
	const correlations = $derived({
		title: m.landing_feature_correlations_title(),
		description: m.landing_feature_correlations_desc()
	});
</script>

{#snippet feature(item: { title: string; description: string }, night: boolean)}
	<div>
		<h2 class="text-2xl md:text-3xl">{item.title}</h2>
		<p class={night ? 'mt-3 max-w-[38ch] text-moon-2' : 'mt-3 max-w-[38ch] text-ink-2'}>
			{item.description}
		</p>
	</div>
{/snippet}

<svelte:head>
	<title>{m.app_name()}: {m.landing_title()}</title>
	<meta name="description" content={m.landing_subtitle()} />
</svelte:head>

<SiteHeader />

<main>
	<!-- The page is one day: the claim and what HomeFit reads from your training on the day
	     ground, then down past the horizon into the night, where the way in, your sleep and how
	     the two meet are set in moonlight. -->
	<section aria-labelledby="landing-title">
		<div
			class="mx-auto grid w-full max-w-(--container) gap-10 px-4 pt-16 pb-10 md:min-h-[min(30rem,calc(100svh-24rem))] md:px-8 md:pt-20 md:pb-12 lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:items-end lg:gap-16"
		>
			<h1
				id="landing-title"
				class="text-[clamp(3rem,7.4vw,7rem)] leading-[0.92] font-figure tracking-[-0.01em]"
			>
				{#each titleLines as line, index (index)}
					<span class="block">{line}</span>
				{/each}
			</h1>
			{@render feature(training, false)}
		</div>

		<div class="border-t border-ink bg-night text-moon">
			<div
				class="mx-auto grid w-full max-w-(--container) gap-12 px-4 pt-10 pb-20 md:px-8 md:pt-12 md:pb-28 lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:gap-16"
			>
				<div class="flex flex-col gap-8">
					<p class="max-w-[44ch] text-lg text-moon-2 md:text-xl">{m.landing_subtitle()}</p>
					<!-- Signed-in visitors are sent to the dashboard by the page's server load. -->
					<div class="flex flex-wrap gap-3">
						<a
							href={resolve('sign-in')}
							class={buttonVariants({
								size: 'lg',
								class: 'bg-moon text-night hover:bg-moon/90 focus-visible:ring-offset-night'
							})}
						>
							{m.landing_signin()}
						</a>
						{#if page.data.signupEnabled}
							<a
								href={resolve('sign-up')}
								class={buttonVariants({
									size: 'lg',
									variant: 'outline',
									class:
										'border-moon-2/60 bg-transparent text-moon hover:border-moon hover:bg-night-2 focus-visible:ring-offset-night'
								})}
							>
								{m.sign_up()}
							</a>
						{/if}
					</div>
				</div>
				<div class="flex flex-col gap-8">
					{@render feature(sleep, true)}
					<div class="border-t border-night-rule pt-8">
						{@render feature(correlations, true)}
					</div>
				</div>
			</div>
		</div>
	</section>
</main>
