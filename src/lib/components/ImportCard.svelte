<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { importSleepBatch, importWorkoutBatch } from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { parseSleepCsv, type ParsedSleepRecord } from '#lib/csv/sleep.js';
	import { parseHevyCsv, type ParsedWorkout } from '#lib/csv/hevy.js';
	import { toast } from 'svelte-sonner';
	import type { Component } from 'svelte';

	const SLEEP_BATCH = 200;
	const HEVY_BATCH = 30;

	let {
		title,
		description,
		kind,
		icon: Icon
	}: {
		title: string;
		description: string;
		kind: 'sleep' | 'hevy';
		icon: Component;
	} = $props();

	let sleepRecords = $state<ParsedSleepRecord[] | null>(null);
	let hevyWorkouts = $state<ParsedWorkout[] | null>(null);
	let parseError = $state(false);
	let importing = $state(false);
	// Records sent so far while the file is imported in batches.
	let sent = $state(0);
	let result = $state<string | null>(null);

	const parsedCount = $derived(sleepRecords?.length ?? hevyWorkouts?.length ?? 0);

	async function onFileChange(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		parseError = false;
		result = null;
		sleepRecords = null;
		hevyWorkouts = null;
		try {
			const text = await file.text();
			if (kind === 'sleep') {
				sleepRecords = parseSleepCsv(text);
				if (sleepRecords.length === 0) throw new Error('No records found');
			} else {
				hevyWorkouts = parseHevyCsv(text);
				if (hevyWorkouts.length === 0) throw new Error('No workouts found');
			}
		} catch {
			sleepRecords = null;
			hevyWorkouts = null;
			parseError = true;
		}
	}

	async function doImport() {
		importing = true;
		sent = 0;
		result = null;
		try {
			let imported = 0;
			let skipped = 0;
			if (kind === 'sleep' && sleepRecords) {
				for (let i = 0; i < sleepRecords.length; i += SLEEP_BATCH) {
					const res = await importSleepBatch({
						records: sleepRecords.slice(i, i + SLEEP_BATCH)
					});
					imported += res.imported;
					skipped += res.skipped;
					sent = Math.min(i + SLEEP_BATCH, sleepRecords.length);
				}
			} else if (kind === 'hevy' && hevyWorkouts) {
				for (let i = 0; i < hevyWorkouts.length; i += HEVY_BATCH) {
					const res = await importWorkoutBatch({
						workouts: hevyWorkouts.slice(i, i + HEVY_BATCH)
					});
					imported += res.imported;
					skipped += res.skipped;
					sent = Math.min(i + HEVY_BATCH, hevyWorkouts.length);
				}
			}
			result = m.import_result({ imported, skipped });
			toast.success(m.import_success());
		} catch (error) {
			toast.error(error instanceof Error ? error.message : m.import_error());
		} finally {
			importing = false;
			// Written batches change the dashboard and exercise views, even if a later one failed.
			if (sent > 0) void refreshAll();
		}
	}
</script>

<Card.Root>
	<Card.Header>
		<div
			class="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary"
		>
			<Icon class="size-5" />
		</div>
		<Card.Title>{title}</Card.Title>
		<Card.Description>{description}</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3">
		<Input
			type="file"
			accept=".csv,text/csv,text/plain"
			disabled={importing}
			aria-label={title}
			onchange={onFileChange}
		/>

		{#if parseError}
			<p class="text-sm text-destructive">{m.import_error()}</p>
		{:else if parsedCount > 0}
			<p class="text-sm text-muted-foreground">
				{m.import_file_ready({ count: parsedCount })}
			</p>
		{/if}

		{#if importing}
			<div class="flex flex-col gap-1.5">
				<Progress value={sent} max={parsedCount} aria-labelledby="{kind}-import-progress" />
				<p id="{kind}-import-progress" class="text-xs text-muted-foreground tabular-nums">
					{sent} / {parsedCount}
				</p>
			</div>
		{/if}

		{#if result}
			<p class="text-sm font-medium text-green-600 dark:text-green-400" role="status">{result}</p>
		{/if}

		<Button disabled={parsedCount === 0 || importing} onclick={doImport} class="w-full sm:w-auto">
			{#if importing}
				<Spinner class="size-4" />
				{m.import_importing()}
			{:else}
				{m.import_button()}
			{/if}
		</Button>
	</Card.Content>
</Card.Root>
