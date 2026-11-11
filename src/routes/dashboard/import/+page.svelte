<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import { getCsvSettings, updateImportTimeZone } from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import ImportCard from '#lib/components/ImportCard.svelte';
	import GoogleHealthImportCard from '#lib/components/google-health/GoogleHealthImportCard.svelte';

	const settings = getCsvSettings();
	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	let savedZone = $state<string>();
	const currentZone = $derived(savedZone ?? settings.current);
	const zones = $derived(
		[...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', currentZone ?? browserZone])].sort()
	);
	let zone = $state('UTC');
	let zoneOpen = $state(false);
	let saving = $state(false);
	let zoneRevision = $state(0);

	function openZoneDialog() {
		zone = currentZone ?? browserZone;
		zoneOpen = true;
	}

	async function saveZone(event: SubmitEvent) {
		event.preventDefault();
		if (saving) return;
		saving = true;
		const selected = zone;
		try {
			await updateImportTimeZone(selected);
			savedZone = selected;
			zoneRevision++;
			zoneOpen = false;
			await refreshAll();
		} catch {
			toast.error(m.import_timezone_error());
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{m.import_title()}: {m.app_name()}</title>
</svelte:head>

<!-- The page is one ledger, so its heavy opening rule stands in for the header's hairline. -->
<div class="pt-7 pb-8">
	<h1 class="text-4xl">{m.import_title()}</h1>
	<p class="mt-1.5 max-w-[80ch] text-sm text-ink-3">{m.import_desc()}</p>
	{#if settings.ready}
		<p class="mt-2 text-sm text-ink-3" data-testid="export-zone">
			{currentZone
				? m.import_timezone({ zone: currentZone })
				: m.import_timezone_first({ zone: browserZone })}
			<Button variant="link" class="ml-1 h-auto p-0 text-sm" onclick={openZoneDialog}
				>{m.import_timezone_change()}</Button
			>
		</p>
	{/if}
</div>

<!-- Only the CSV cards reset when their export zone changes. -->
<div class="bleed">
	<div class="divide-y divide-rule border-t border-ink">
		{#if page.data.googleHealthEnabled}
			<GoogleHealthImportCard />
		{/if}
		{#key zoneRevision}
			<ImportCard kind="hevy" title={m.import_hevy_title()} description={m.import_hevy_desc()} />
		{/key}
	</div>
	<div class="bleed">
		{#key zoneRevision}
			<ImportCard kind="sleep" title={m.import_sleep_title()} description={m.import_sleep_desc()} />
		{/key}
	</div>
</div>

<Dialog.Root bind:open={zoneOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.import_timezone_dialog_title()}</Dialog.Title>
			<Dialog.Description>{m.import_timezone_warning()}</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={saveZone} class="flex flex-col gap-6">
			<Field.FieldGroup>
				<Field.Field>
					<Field.FieldLabel for="import-zone">{m.import_timezone_label()}</Field.FieldLabel>
					<select
						id="import-zone"
						bind:value={zone}
						disabled={saving}
						class="h-9 w-full min-w-0 rounded-md border border-input bg-card px-2.5 py-1 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 md:text-sm"
					>
						{#each zones as timeZone (timeZone)}
							<option value={timeZone}>{timeZone}</option>
						{/each}
					</select>
				</Field.Field>
			</Field.FieldGroup>
			<Dialog.Footer>
				<Button variant="outline" type="button" disabled={saving} onclick={() => (zoneOpen = false)}
					>{m.google_health_cancel()}</Button
				>
				<Button type="submit" disabled={saving}>
					{#if saving}<Spinner data-icon="inline-start" stroke="currentColor" />{/if}
					{m.import_timezone_save()}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
