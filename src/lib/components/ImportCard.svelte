<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { importSleepBatch, importWorkoutBatch } from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { parseSleepCsv, SleepCsvError, type ParsedSleepRecord } from '#lib/csv/sleep.js';
	import { parseHevyCsv, type ParsedWorkout } from '#lib/csv/hevy.js';
	import { cn } from '#lib/utils.js';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { toast } from 'svelte-sonner';
	import type { Component } from 'svelte';

	const SLEEP_BATCH = 200;
	const HEVY_BATCH = 30;

	// The import ledger names each source in words, so `icon` is accepted for callers but not drawn.
	// eslint-disable-next-line svelte/no-unused-props
	let {
		title,
		description,
		kind
	}: {
		title: string;
		description: string;
		kind: 'sleep' | 'hevy';
		icon: Component;
	} = $props();

	let sleepRecords = $state<ParsedSleepRecord[] | null>(null);
	let hevyWorkouts = $state<ParsedWorkout[] | null>(null);
	let fileName = $state<string | null>(null);
	let parseError = $state<string | null>(null);
	let importing = $state(false);
	// Records sent so far while the file is imported in batches.
	let sent = $state(0);
	let result = $state<string | null>(null);

	const parsedCount = $derived(sleepRecords?.length ?? hevyWorkouts?.length ?? 0);
	// Sleep belongs to the night field everywhere in HomeFit, so its source is drawn on it too.
	const night = $derived(kind === 'sleep');

	async function onFileChange(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		fileName = file.name;
		parseError = null;
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
		} catch (error) {
			sleepRecords = null;
			hevyWorkouts = null;
			parseError =
				error instanceof SleepCsvError
					? m.import_invalid_sleep_row({ row: error.row })
					: m.import_error();
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

<!-- One row of the import ledger: the source named on the left, its file and state on the right.
     The sleep source is a band of the night field that bleeds to both edges of the page grid. -->
<div class={cn(night && 'bleed bg-night text-moon')}>
	<div
		class={cn(
			'grid gap-x-14 gap-y-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]',
			night ? 'pt-9 pb-14' : 'py-8'
		)}
	>
		<div class="min-w-0">
			<h2 class="text-xl">{title}</h2>
			<p class={cn('mt-1.5 max-w-[48ch] text-sm', night ? 'text-moon-2' : 'text-ink-3')}>
				{description}
			</p>
		</div>

		<div class="flex min-w-0 flex-col gap-2.5">
			<div class="flex flex-wrap items-center gap-2">
				<!-- The native file input stays the control; the label is its visible face, in the
				     page's language rather than the browser's. -->
				<label
					class={cn(
						'inline-flex h-9 shrink-0 cursor-pointer items-center rounded-(--radius-control) border px-3 text-sm font-medium transition-colors duration-(--dur-micro) select-none has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus has-disabled:cursor-not-allowed has-disabled:opacity-55',
						night
							? 'border-night-rule text-moon hover:border-moon-2 hover:bg-night-2'
							: 'border-rule-2 bg-day hover:border-field-edge hover:bg-day-2'
					)}
				>
					<input
						type="file"
						class="sr-only"
						accept=".csv,text/csv,text/plain"
						disabled={importing}
						aria-label={title}
						onchange={onFileChange}
					/>
					{m.import_select_file()}
				</label>
				<Button
					disabled={parsedCount === 0 || importing}
					onclick={doImport}
					class={cn(night && 'bg-moon text-night hover:bg-moon/90')}
				>
					{#if importing}
						<Spinner class="size-4" stroke="currentColor" />
						{m.import_importing()}
					{:else}
						{m.import_button()}
					{/if}
				</Button>
			</div>

			<!-- The chosen file, then what was read from it. -->
			<div class="mt-1 flex min-w-0 flex-col gap-1 empty:hidden">
				{#if fileName}
					<p class={cn('truncate text-sm', night ? 'text-moon' : 'text-ink')}>{fileName}</p>
				{/if}
				{#if parseError}
					<p
						class={cn(
							'flex max-w-[60ch] items-start gap-1.5 text-sm',
							night ? 'font-medium text-moon' : 'text-error'
						)}
						role="alert"
					>
						<AlertCircleIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						{parseError}
					</p>
				{:else if parsedCount > 0}
					<p class={cn('text-sm', night ? 'text-moon-2' : 'text-ink-3')}>
						{m.import_file_ready({ count: parsedCount })}
					</p>
				{/if}
			</div>

			{#if importing}
				<div class="flex max-w-md items-center gap-3">
					<Progress
						value={sent}
						max={parsedCount}
						aria-labelledby="{kind}-import-progress"
						class={cn(
							'flex-1 rounded-none',
							night ? 'bg-night-rule [&>[data-slot=progress-indicator]]:bg-sleep' : 'bg-rule'
						)}
					/>
					<p
						id="{kind}-import-progress"
						class={cn('shrink-0 text-sm', night ? 'text-moon-2' : 'text-ink-3')}
					>
						{sent} / {parsedCount}
					</p>
				</div>
			{/if}

			{#if result}
				<p
					class={cn(
						'flex items-start gap-1.5 text-sm font-medium',
						night ? 'text-moon' : 'text-success'
					)}
					role="status"
				>
					<CheckIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					{result}
				</p>
			{/if}
		</div>
	</div>
</div>
