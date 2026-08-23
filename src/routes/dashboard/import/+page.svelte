<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import ImportCard from '$lib/components/ImportCard.svelte';
	import GoogleHealthImportCard from '$lib/components/google-health/GoogleHealthImportCard.svelte';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
</script>

<div class="flex flex-col gap-6">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">{m.import_title()}</h1>
		<p class="text-sm text-muted-foreground">{m.import_desc()}</p>
	</div>

	<div class="grid gap-4 md:grid-cols-2">
		<GoogleHealthImportCard />
		<ImportCard
			kind="sleep"
			title={m.import_sleep_title()}
			description={m.import_sleep_desc()}
			icon={MoonIcon}
		/>
		<ImportCard
			kind="hevy"
			title={m.import_hevy_title()}
			description={m.import_hevy_desc()}
			icon={DumbbellIcon}
		/>
	</div>
</div>
