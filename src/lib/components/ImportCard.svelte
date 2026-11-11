<script lang="ts">
	import { isHttpError } from '@sveltejs/kit';
	import { refreshAll } from '$app/navigation';
	import {
		deleteCsvData,
		getImportTimeZone,
		importSleepBatch,
		importWorkoutBatch
	} from '#lib/remote/imports.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { CSV_DELETE_CONFIRMATION } from '#lib/csv/confirmation.js';
	import { parseSleepCsv, type ParsedSleepRecord } from '#lib/csv/sleep.js';
	import { parseHevyCsv, type ParsedWorkout } from '#lib/csv/hevy.js';
	import { cn } from '#lib/utils.js';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { toast } from 'svelte-sonner';

	const SLEEP_BATCH = 200;
	const HEVY_BATCH = 30;

	let {
		title,
		description,
		kind
	}: {
		title: string;
		description: string;
		kind: 'sleep' | 'hevy';
	} = $props();

	let sleepRecords = $state<ParsedSleepRecord[] | null>(null);
	let hevyWorkouts = $state<ParsedWorkout[] | null>(null);
	let fileName = $state<string | null>(null);
	let parseError = $state<string | null>(null);
	let invalidRows = $state<number[]>([]);
	let importing = $state(false);
	let parsing = $state(false);
	let parsedZone = $state('UTC');
	// Records sent so far while the file is imported in batches.
	let sent = $state(0);
	let result = $state<string | null>(null);

	const parsedCount = $derived(sleepRecords?.length ?? hevyWorkouts?.length ?? 0);
	// Sleep belongs to the night field everywhere in HomeFit, so its source is drawn on it too.
	const night = $derived(kind === 'sleep');

	async function onFileChange(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		parsing = true;
		fileName = file.name;
		parseError = null;
		invalidRows = [];
		result = null;
		sleepRecords = null;
		hevyWorkouts = null;
		try {
			const text = await file.text();
			// Export times are read in the zone saved for this account; the first file saves it.
			const timeZone = await getImportTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
			parsedZone = timeZone;
			if (kind === 'sleep') {
				const parsed = parseSleepCsv(text, timeZone);
				sleepRecords = parsed.records;
				invalidRows = parsed.invalidRows;
				if (sleepRecords.length === 0) {
					parseError = m.import_no_valid_sleep_rows();
				}
			} else {
				hevyWorkouts = parseHevyCsv(text, timeZone);
				if (hevyWorkouts.length === 0) throw new Error('No workouts found');
			}
		} catch {
			sleepRecords = null;
			hevyWorkouts = null;
			parseError = m.import_error();
		} finally {
			parsing = false;
		}
	}

	let deleteOpen = $state(false);
	let deleting = $state(false);
	let confirmation = $state('');
	const deletePhrase = $derived(CSV_DELETE_CONFIRMATION[kind]);
	function closeDeleteDialog() {
		deleteOpen = false;
		confirmation = '';
	}
	async function removeData() {
		if (confirmation !== deletePhrase || deleting || importing) return;
		deleting = true;
		try {
			await deleteCsvData({ source: kind, confirmation });
			deleteOpen = false;
			confirmation = '';
			result = null;
			await refreshAll();
		} catch {
			toast.error(m.import_delete_error());
		} finally {
			deleting = false;
		}
	}

	async function doImport() {
		const sleep = sleepRecords;
		const workouts = hevyWorkouts;
		const timeZone = parsedZone;
		const manifest = workouts?.map(({ startTime, endTime, title }) => ({
			startTime,
			endTime,
			title
		}));
		importing = true;
		sent = 0;
		result = null;
		try {
			let imported = 0;
			let skipped = 0;
			let updated = 0;
			if (kind === 'sleep' && sleep) {
				for (let i = 0; i < sleep.length; i += SLEEP_BATCH) {
					const res = await importSleepBatch({
						timeZone,
						records: sleep.slice(i, i + SLEEP_BATCH)
					});
					imported += res.imported;
					skipped += res.skipped;
					updated += res.updated;
					sent = Math.min(i + SLEEP_BATCH, sleep.length);
				}
			} else if (kind === 'hevy' && workouts) {
				for (let i = 0; i < workouts.length; i += HEVY_BATCH) {
					const res = await importWorkoutBatch({
						timeZone,
						workouts: workouts.slice(i, i + HEVY_BATCH),
						manifest: manifest ?? []
					});
					imported += res.imported;
					skipped += res.skipped;
					updated += res.updated;
					sent = Math.min(i + HEVY_BATCH, workouts.length);
				}
			}
			result = m.import_result({ imported, updated, skipped });
			toast.success(m.import_success());
		} catch (error) {
			const message =
				isHttpError(error) && error.status < 500 ? error.body.message : m.import_failed();
			toast.error(sent > 0 ? `${message} ${m.import_partial_saved()}` : message);
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
			<Button
				variant="link"
				class={cn(
					'mt-4 h-auto p-0 text-sm',
					night ? 'text-moon-2 hover:text-moon' : 'text-ink-3 hover:text-ink'
				)}
				disabled={importing || parsing || deleting}
				onclick={() => {
					confirmation = '';
					deleteOpen = true;
				}}>{m.import_delete()}</Button
			>
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
						disabled={importing || parsing || deleting}
						aria-label={title}
						onchange={onFileChange}
					/>
					{m.import_select_file()}
				</label>
				<Button
					disabled={parsedCount === 0 || importing || deleting}
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
				{#if invalidRows.length > 0}
					<details class={cn('text-sm', night ? 'text-moon-2' : 'text-ink-3')}>
						<summary class="cursor-pointer">
							{m.import_invalid_sleep_rows_skipped({ count: invalidRows.length })}
						</summary>
						<p class="mt-2 max-h-40 overflow-y-auto break-words">
							{m.import_invalid_sleep_rows_list({ rows: invalidRows.join(', ') })}
						</p>
						<p class="mt-1">{m.import_invalid_sleep_rows_hint()}</p>
					</details>
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

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.import_delete_title({ source: title })}</AlertDialog.Title>
			<AlertDialog.Description>{m.import_delete_description()}</AlertDialog.Description>
		</AlertDialog.Header>
		<Field.FieldGroup>
			<Field.Field>
				<Field.FieldLabel for="{kind}-delete-confirmation"
					>{m.google_health_delete_confirmation_label()}</Field.FieldLabel
				>
				<Input
					id="{kind}-delete-confirmation"
					bind:value={confirmation}
					autocomplete="off"
					aria-describedby="{kind}-delete-confirmation-hint"
				/>
				<Field.FieldDescription id="{kind}-delete-confirmation-hint"
					>{m.import_delete_confirmation({ phrase: deletePhrase })}</Field.FieldDescription
				>
			</Field.Field>
		</Field.FieldGroup>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={deleting} onclick={closeDeleteDialog}
				>{m.google_health_cancel()}</AlertDialog.Cancel
			>
			<AlertDialog.Action
				variant="destructive"
				disabled={deleting || confirmation !== deletePhrase}
				onclick={removeData}
			>
				{#if deleting}<Spinner data-icon="inline-start" stroke="currentColor" />{/if}
				{m.import_delete()}</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
