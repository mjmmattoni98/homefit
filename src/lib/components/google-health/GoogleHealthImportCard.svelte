<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$convex/_generated/api';
	import { useAction, useAuth, useMutation, useQuery } from 'convex-svelte';
	import * as m from '$lib/paraglide/messages';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Progress } from '$lib/components/ui/progress';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
	import { formatDateLong } from '$lib/format';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import HeartPulseIcon from '@lucide/svelte/icons/heart-pulse';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { toast } from 'svelte-sonner';

	const IMPORT_RETURN_PATH = '/dashboard/import';
	const DELETE_CONFIRMATION = 'DELETE GOOGLE DATA';
	const SUPPORTED_METRIC_TYPES = 40;
	type Props = { navigate?: (authorizationUrl: string) => void };

	let { navigate = (authorizationUrl) => window.location.assign(authorizationUrl) }: Props =
		$props();

	const auth = useAuth();
	const connectionQuery = useQuery(api.googleHealth.model.getConnectionStatus, () =>
		auth.isAuthenticated ? {} : 'skip'
	);
	const beginConnection = useAction(api.googleHealth.oauth.beginConnection);
	const syncNow = useMutation(api.googleHealth.account.syncNow);
	const disconnect = useAction(api.googleHealth.account.disconnect);
	const deleteImportedData = useAction(api.googleHealth.account.deleteImportedData);

	let pending = $state<'connect' | 'sync' | 'disconnect' | 'delete' | null>(null);
	let disconnectOpen = $state(false);
	let deleteOpen = $state(false);
	let deleteConfirmation = $state('');

	const connection = $derived(connectionQuery.data);
	const isLoading = $derived(auth.isLoading || !auth.isAuthenticated || connectionQuery.isLoading);
	const isPending = $derived(pending !== null);
	const completedTypes = $derived(connection?.backfillCompletedTypes ?? 0);
	const totalTypes = $derived(connection?.backfillTotalTypes ?? 0);
	const hasPartialAccess = $derived(
		connection !== null && connection !== undefined && totalTypes < SUPPORTED_METRIC_TYPES
	);

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
			await syncNow({});
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
			await disconnect({});
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

<Card.Root>
	<Card.Header>
		<div class="flex items-start justify-between gap-3">
			<div class="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
				<HeartPulseIcon aria-hidden="true" />
			</div>
			{#if connection === null}
				<Badge variant="outline">{m.google_health_status_not_connected()}</Badge>
			{:else if connection !== undefined}
				<Badge variant={connection.status === 'action_required' ? 'destructive' : 'secondary'}>
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
				</Badge>
			{/if}
		</div>
		<Card.Title>{m.google_health_title()}</Card.Title>
		<Card.Description>{m.google_health_description()}</Card.Description>
	</Card.Header>

	<Card.Content class="flex flex-col gap-4" aria-busy={isLoading || isPending}>
		{#if isLoading}
			<p class="sr-only" aria-live="polite">{m.google_health_loading()}</p>
			<div class="flex flex-col gap-3">
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-7 w-40" />
			</div>
		{:else if connectionQuery.error}
			<Alert.Root variant="destructive">
				<AlertCircleIcon aria-hidden="true" />
				<Alert.Title>{m.google_health_error_title()}</Alert.Title>
				<Alert.Description>{m.google_health_error_description()}</Alert.Description>
			</Alert.Root>
		{:else if connection === null}
			<p class="text-sm text-muted-foreground">
				{m.google_health_not_connected_description()}
			</p>
			<Button disabled={isPending} onclick={startConnection} class="w-full sm:w-fit">
				{#if pending === 'connect'}
					<Spinner data-icon="inline-start" />
				{/if}
				{m.google_health_connect()}
			</Button>
		{:else if connection !== undefined}
			{#if connection.status === 'connecting' || connection.status === 'backfilling'}
				<div class="flex flex-col gap-3">
					<div>
						<p class="text-sm font-medium">
							{connection.status === 'connecting'
								? m.google_health_connecting_title()
								: m.google_health_importing_title()}
						</p>
						<p class="text-sm text-muted-foreground">
							{connection.status === 'connecting'
								? m.google_health_connecting_description()
								: m.google_health_importing_description()}
						</p>
					</div>
					<p id="google-health-progress-label" class="text-sm">
						{m.google_health_progress({ completed: completedTypes, total: totalTypes })}
					</p>
					<Progress
						value={completedTypes}
						max={Math.max(totalTypes, 1)}
						aria-labelledby="google-health-progress-label"
					/>
				</div>
			{:else if connection.status === 'delayed'}
				<Alert.Root>
					<InfoIcon aria-hidden="true" />
					<Alert.Title>{m.google_health_delayed_title()}</Alert.Title>
					<Alert.Description>{m.google_health_delayed_description()}</Alert.Description>
				</Alert.Root>
			{:else if connection.status === 'action_required'}
				<Alert.Root variant="destructive">
					<AlertCircleIcon aria-hidden="true" />
					<Alert.Title>{m.google_health_action_required_title()}</Alert.Title>
					<Alert.Description>
						{m.google_health_action_required_description()}
					</Alert.Description>
				</Alert.Root>
			{:else if connection.status === 'disconnected'}
				<Alert.Root>
					<InfoIcon aria-hidden="true" />
					<Alert.Title>{m.google_health_retained_title()}</Alert.Title>
					<Alert.Description>{m.google_health_retained_description()}</Alert.Description>
				</Alert.Root>
			{:else if connection.status === 'deleting'}
				<div class="flex items-start gap-2" aria-live="polite">
					<Spinner />
					<p class="text-sm text-muted-foreground">
						{m.google_health_deleting_description()}
					</p>
				</div>
			{:else}
				<div class="flex flex-col gap-1">
					<p class="text-sm font-medium">
						{m.google_health_metric_types_connected({ count: totalTypes })}
					</p>
					<p class="text-sm text-muted-foreground">
						{connection.lastSuccessfulSyncAt === undefined
							? m.google_health_never_synced()
							: m.google_health_last_sync({
									date: formatDateLong(connection.lastSuccessfulSyncAt)
								})}
					</p>
				</div>
				{#if hasPartialAccess}
					<Alert.Root>
						<InfoIcon aria-hidden="true" />
						<Alert.Title>{m.google_health_partial_access_title()}</Alert.Title>
						<Alert.Description>
							{m.google_health_partial_access_description()}
						</Alert.Description>
					</Alert.Root>
				{/if}
			{/if}

			{#if connection.status !== 'deleting' && connection.status !== 'connecting' && connection.status !== 'backfilling'}
				<div class="flex flex-wrap gap-2">
					{#if connection.status === 'active'}
						<Button disabled={isPending} onclick={requestSync}>
							{#if pending === 'sync'}<Spinner data-icon="inline-start" />{/if}
							{m.google_health_sync_now()}
						</Button>
					{/if}
					{#if connection.status === 'action_required' || connection.status === 'disconnected' || hasPartialAccess}
						<Button variant="outline" disabled={isPending} onclick={startConnection}>
							{#if pending === 'connect'}<Spinner data-icon="inline-start" />{/if}
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
					<Button variant="destructive" disabled={isPending} onclick={() => (deleteOpen = true)}>
						{m.google_health_delete_data()}
					</Button>
				</div>
			{/if}
		{/if}
	</Card.Content>
</Card.Root>

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
				{#if pending === 'disconnect'}<Spinner data-icon="inline-start" />{/if}
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
				{#if pending === 'delete'}<Spinner data-icon="inline-start" />{/if}
				{m.google_health_delete_dialog_confirm()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
