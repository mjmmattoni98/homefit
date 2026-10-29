<script lang="ts">
	import { onMount } from 'svelte';
	import {
		beginConnection,
		deleteImportedData,
		disconnect,
		getConnectionStatus,
		syncNow
	} from '#lib/remote/health.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { formatDateLong } from '#lib/format.js';
	import { cn } from '#lib/utils.js';
	import { toast } from 'svelte-sonner';

	const IMPORT_RETURN_PATH = '/dashboard/import';
	const DELETE_CONFIRMATION = 'DELETE GOOGLE DATA';
	const SUPPORTED_METRIC_TYPES = 40;
	const POLL_INTERVAL_MS = 5_000;
	const STATUS_POLL_INTERVAL_MS = 30_000;
	const ACTIVE_STATUSES = new Set<string>(['connecting', 'backfilling', 'delayed', 'deleting']);
	type Props = { navigate?: (authorizationUrl: string) => void };

	let { navigate = (authorizationUrl) => window.location.assign(authorizationUrl) }: Props =
		$props();

	const connectionQuery = getConnectionStatus();

	let pending = $state<'connect' | 'sync' | 'disconnect' | 'delete' | null>(null);
	let disconnectOpen = $state(false);
	let deleteOpen = $state(false);
	let deleteConfirmation = $state('');

	const connection = $derived(connectionQuery.current);
	const status = $derived(connection?.status);
	const isLoading = $derived(!connectionQuery.ready && connectionQuery.error === undefined);
	const isPending = $derived(pending !== null);
	const completedTypes = $derived(connection?.backfillCompletedTypes ?? 0);
	const totalTypes = $derived(connection?.backfillTotalTypes ?? 0);
	const hasPartialAccess = $derived(
		connection !== null && connection !== undefined && totalTypes < SUPPORTED_METRIC_TYPES
	);

	// Progress is written by the background worker, and background syncs and other tabs change the
	// connection too: poll often while the worker is in flight or retrying, slowly otherwise.
	$effect(() => {
		const interval =
			status !== undefined && ACTIVE_STATUSES.has(status)
				? POLL_INTERVAL_MS
				: STATUS_POLL_INTERVAL_MS;
		const timer = setInterval(() => void connectionQuery.refresh(), interval);
		return () => clearInterval(timer);
	});

	onMount(() => {
		const result = new URL(window.location.href).searchParams.get('googleHealth');
		if (result === 'connected') toast.success(m.google_health_feedback_connected());
		if (result === 'error') toast.error(m.google_health_feedback_error());
	});

	async function startConnection(): Promise<void> {
		if (isPending) return;
		pending = 'connect';
		try {
			const { authorizationUrl } = await beginConnection({ returnPath: IMPORT_RETURN_PATH });
			navigate(authorizationUrl);
		} catch {
			toast.error(m.google_health_action_error());
			pending = null;
		}
	}

	async function requestSync(): Promise<void> {
		if (isPending) return;
		pending = 'sync';
		try {
			await syncNow();
			toast.success(m.google_health_feedback_sync());
		} catch {
			toast.error(m.google_health_action_error());
		} finally {
			pending = null;
		}
	}

	async function confirmDisconnect(): Promise<void> {
		if (isPending) return;
		pending = 'disconnect';
		try {
			await disconnect();
			disconnectOpen = false;
			toast.success(m.google_health_feedback_disconnected());
		} catch {
			toast.error(m.google_health_action_error());
		} finally {
			pending = null;
		}
	}

	async function confirmDeletion(): Promise<void> {
		if (isPending || deleteConfirmation !== DELETE_CONFIRMATION) return;
		pending = 'delete';
		try {
			await deleteImportedData({ confirmation: DELETE_CONFIRMATION });
			deleteOpen = false;
			deleteConfirmation = '';
			toast.success(m.google_health_feedback_deleting());
		} catch {
			toast.error(m.google_health_action_error());
		} finally {
			pending = null;
		}
	}

	function closeDeleteDialog(): void {
		deleteOpen = false;
		deleteConfirmation = '';
	}
</script>

<!-- One row of the import ledger: Google Health named on the left; its state, progress, last sync
     and actions on the right. The state is a plain word at the head of the column, never a badge,
     and the row's one filled button is whatever moves the connection forward. -->
<div class="grid gap-x-14 gap-y-5 py-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
	<div class="min-w-0">
		<h2 class="text-xl">{m.google_health_title()}</h2>
		<p class="mt-1.5 max-w-[48ch] text-sm text-ink-3">{m.google_health_description()}</p>
	</div>

	<div class="flex min-w-0 flex-col items-start gap-5" aria-busy={isLoading || isPending}>
		{#if isLoading}
			<p class="sr-only" aria-live="polite">{m.google_health_loading()}</p>
			<div class="flex w-full flex-col gap-2.5">
				<Skeleton class="h-5 w-28" />
				<Skeleton class="h-4 w-3/4 max-w-sm" />
				<Skeleton class="mt-2.5 h-9 w-44" />
			</div>
		{:else if connectionQuery.error !== undefined}
			<div role="alert">
				<p class="font-medium text-error">{m.google_health_error_title()}</p>
				<p class="mt-1 text-sm text-ink-3">{m.google_health_error_description()}</p>
			</div>
		{:else if connection === null}
			<div>
				<p class="font-medium">{m.google_health_status_not_connected()}</p>
				<p class="mt-1 text-sm text-ink-3">{m.google_health_not_connected_description()}</p>
			</div>
			<Button disabled={isPending} onclick={startConnection} class="w-full sm:w-fit">
				{#if pending === 'connect'}
					<Spinner data-icon="inline-start" stroke="currentColor" />
				{/if}
				{m.google_health_connect()}
			</Button>
		{:else if connection !== undefined}
			<div class="w-full">
				<p class={cn('font-medium', connection.status === 'action_required' && 'text-error')}>
					{#if connection.status === 'connecting' || connection.status === 'backfilling'}
						{m.google_health_status_importing()}
					{:else if connection.status === 'active'}
						{m.google_health_status_connected()}
					{:else if connection.status === 'delayed'}
						{m.google_health_status_delayed()}
					{:else if connection.status === 'action_required'}
						{m.google_health_status_action_required()}
					{:else if connection.status === 'disconnected'}
						{m.google_health_status_disconnected()}
					{:else}
						{m.google_health_status_deleting()}
					{/if}
				</p>

				{#if connection.status === 'connecting' || connection.status === 'backfilling'}
					<p class="mt-1 text-sm text-ink-2">
						{connection.status === 'connecting'
							? m.google_health_connecting_title()
							: m.google_health_importing_title()}
					</p>
					<p class="text-sm text-ink-3">
						{connection.status === 'connecting'
							? m.google_health_connecting_description()
							: m.google_health_importing_description()}
					</p>
					<div class="mt-4 flex max-w-md flex-col gap-2">
						<p id="google-health-progress-label" class="text-sm">
							{m.google_health_progress({ completed: completedTypes, total: totalTypes })}
						</p>
						<Progress
							value={completedTypes}
							max={Math.max(totalTypes, 1)}
							aria-labelledby="google-health-progress-label"
							class="rounded-none bg-rule"
						/>
					</div>
				{:else if connection.status === 'delayed'}
					<p class="mt-1 text-sm text-ink-2">{m.google_health_delayed_title()}</p>
					<p class="text-sm text-ink-3">{m.google_health_delayed_description()}</p>
				{:else if connection.status === 'action_required'}
					<p class="mt-1 text-sm text-ink-2">{m.google_health_action_required_title()}</p>
					<p class="text-sm text-ink-3">{m.google_health_action_required_description()}</p>
				{:else if connection.status === 'disconnected'}
					<p class="mt-1 text-sm text-ink-2">{m.google_health_retained_title()}</p>
					<p class="text-sm text-ink-3">{m.google_health_retained_description()}</p>
				{:else if connection.status === 'deleting'}
					<div class="mt-1 flex items-start gap-2" aria-live="polite">
						<Spinner class="mt-0.5 shrink-0 text-ink-3" stroke="currentColor" />
						<p class="text-sm text-ink-3">{m.google_health_deleting_description()}</p>
					</div>
				{:else}
					<p class="mt-1 text-sm text-ink-2">
						{m.google_health_metric_types_connected({ count: totalTypes })}
					</p>
					<p class="text-sm text-ink-3">
						{connection.lastSuccessfulSyncAt === undefined
							? m.google_health_never_synced()
							: m.google_health_last_sync({
									date: formatDateLong(connection.lastSuccessfulSyncAt)
								})}
					</p>
					{#if hasPartialAccess}
						<p class="mt-4 text-sm text-ink-2">{m.google_health_partial_access_title()}</p>
						<p class="text-sm text-ink-3">{m.google_health_partial_access_description()}</p>
					{/if}
				{/if}
			</div>

			{#if connection.status !== 'deleting' && connection.status !== 'connecting' && connection.status !== 'backfilling'}
				<div class="flex w-full flex-wrap items-center gap-2">
					{#if connection.status === 'active'}
						<Button disabled={isPending} onclick={requestSync}>
							{#if pending === 'sync'}<Spinner
									data-icon="inline-start"
									stroke="currentColor"
								/>{/if}
							{m.google_health_sync_now()}
						</Button>
					{/if}
					{#if connection.status === 'action_required' || connection.status === 'disconnected' || hasPartialAccess}
						<!-- Without a sync to run, reviewing access or reconnecting is the way forward. -->
						<Button
							variant={connection.status === 'active' ? 'outline' : 'default'}
							disabled={isPending}
							onclick={startConnection}
						>
							{#if pending === 'connect'}<Spinner
									data-icon="inline-start"
									stroke="currentColor"
								/>{/if}
							{connection.status === 'disconnected'
								? m.google_health_reconnect()
								: m.google_health_review_access()}
						</Button>
					{/if}
					{#if connection.status !== 'disconnected'}
						<Button variant="outline" disabled={isPending} onclick={() => (disconnectOpen = true)}>
							{m.google_health_disconnect()}
						</Button>
					{/if}
					<Button
						variant="destructive"
						class="sm:ml-auto"
						disabled={isPending}
						onclick={() => (deleteOpen = true)}
					>
						{m.google_health_delete_data()}
					</Button>
				</div>
			{/if}
		{/if}
	</div>
</div>

<AlertDialog.Root bind:open={disconnectOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.google_health_disconnect_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.google_health_disconnect_dialog_description()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={isPending}>{m.google_health_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action disabled={isPending} onclick={confirmDisconnect}>
				{#if pending === 'disconnect'}<Spinner
						data-icon="inline-start"
						stroke="currentColor"
					/>{/if}
				{m.google_health_disconnect_dialog_confirm()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.google_health_delete_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m.google_health_delete_dialog_description()}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<Field.FieldGroup>
			<Field.Field>
				<Field.FieldLabel for="google-health-delete-confirmation">
					{m.google_health_delete_confirmation_label()}
				</Field.FieldLabel>
				<Input
					id="google-health-delete-confirmation"
					bind:value={deleteConfirmation}
					autocomplete="off"
					aria-describedby="google-health-delete-confirmation-hint"
				/>
				<Field.FieldDescription id="google-health-delete-confirmation-hint">
					{m.google_health_delete_confirmation_hint()}
				</Field.FieldDescription>
			</Field.Field>
		</Field.FieldGroup>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={isPending} onclick={closeDeleteDialog}>
				{m.google_health_cancel()}
			</AlertDialog.Cancel>
			<AlertDialog.Action
				variant="destructive"
				disabled={isPending || deleteConfirmation !== DELETE_CONFIRMATION}
				onclick={confirmDeletion}
			>
				{#if pending === 'delete'}<Spinner data-icon="inline-start" stroke="currentColor" />{/if}
				{m.google_health_delete_dialog_confirm()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
