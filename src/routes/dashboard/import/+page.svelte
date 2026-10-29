<script lang="ts">
	import { page } from '$app/state';
	import * as m from '#lib/paraglide/messages.js';
	import ImportCard from '#lib/components/ImportCard.svelte';
	import GoogleHealthImportCard from '#lib/components/google-health/GoogleHealthImportCard.svelte';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
</script>

<svelte:head>
	<title>{m.import_title()}: {m.app_name()}</title>
</svelte:head>

<!-- The page is one ledger, so its heavy opening rule stands in for the header's hairline. -->
<div class="pt-7 pb-8">
	<h1 class="text-4xl">{m.import_title()}</h1>
	<p class="mt-1.5 max-w-[80ch] text-sm text-ink-3">{m.import_desc()}</p>
</div>

<!-- The sources, read like the overview's horizon: the automatic source and the training log on
     the day ground, then Sleep Cycle below the line on the night field. -->
<div class="bleed">
	<div class="divide-y divide-rule border-t border-ink">
		{#if page.data.googleHealthEnabled}
			<GoogleHealthImportCard />
		{/if}
		<ImportCard
			kind="hevy"
			title={m.import_hevy_title()}
			description={m.import_hevy_desc()}
			icon={DumbbellIcon}
		/>
	</div>
	<div class="bleed">
		<ImportCard
			kind="sleep"
			title={m.import_sleep_title()}
			description={m.import_sleep_desc()}
			icon={MoonIcon}
		/>
	</div>
</div>
