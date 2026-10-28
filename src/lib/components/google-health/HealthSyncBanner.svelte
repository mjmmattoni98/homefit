<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getConnectionStatus } from '#lib/remote/health.remote.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDateLong } from '#lib/format.js';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import InfoIcon from '@lucide/svelte/icons/info';

	// Background jobs and other tabs change what these pages show. Poll the cheap status query, and
	// refresh every health query when the connection appears, disappears, changes status or syncs.
	// While the worker is importing, retrying or deleting, refresh everything more often so the
	// page follows its progress.
	const STATUS_POLL_INTERVAL_MS = 30_000;
	const IMPORT_REFRESH_INTERVAL_MS = 15_000;
	const ACTIVE_STATUSES = new Set<string>(['connecting', 'backfilling', 'delayed', 'deleting']);

	const connectionQuery = getConnectionStatus();

	const connection = $derived(connectionQuery.current);
	const status = $derived(connection?.status);
	const isLoading = $derived(!connectionQuery.ready && connectionQuery.error === undefined);

	$effect(() => {
		if (!page.data.googleHealthEnabled) return;
		const interval =
			status !== undefined && ACTIVE_STATUSES.has(status)
				? setInterval(() => void refreshAll(), IMPORT_REFRESH_INTERVAL_MS)
				: setInterval(() => void connectionQuery.refresh(), STATUS_POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	});

	// The connection state the page last saw, or undefined before it loads. Not reactive: it only
	// remembers what the effect below last saw.
	let seen: string | undefined;
	$effect(() => {
		if (connection === undefined) return;
		const current =
			connection === null
				? 'none'
				: `${connection.status}:${connection.lastSuccessfulSyncAt ?? 'never'}`;
		if (seen !== undefined && current !== seen) void refreshAll();
		seen = current;
	});
</script>

{#if !page.data.googleHealthEnabled}
	<!-- The optional integration is not configured on this server. -->
{:else if isLoading}
	<Skeleton class="h-14 w-full" />
{:else if connectionQuery.error !== undefined}
	<Alert.Root variant="destructive">
		<AlertCircleIcon aria-hidden="true" />
		<Alert.Title>{m.health_query_error_title()}</Alert.Title>
		<Alert.Description>{m.health_query_error_description()}</Alert.Description>
	</Alert.Root>
{:else if connection === null}
	<Alert.Root>
		<InfoIcon aria-hidden="true" />
		<Alert.Title>{m.google_health_status_not_connected()}</Alert.Title>
		<Alert.Description class="flex flex-wrap items-center justify-between gap-3">
			<span>{m.google_health_not_connected_description()}</span>
			<a href={resolve('/dashboard/import')} class={buttonVariants({ size: 'sm' })}>
				{m.google_health_connect()}
			</a>
		</Alert.Description>
	</Alert.Root>
{:else if connection !== undefined}
	{#if connection.status === 'connecting' || connection.status === 'backfilling'}
		<Alert.Root>
			<InfoIcon aria-hidden="true" />
			<Alert.Title>{m.google_health_importing_title()}</Alert.Title>
			<Alert.Description class="flex flex-col gap-2">
				<span>{m.google_health_importing_description()}</span>
				<span id="health-sync-progress">
					{m.google_health_progress({
						completed: connection.backfillCompletedTypes,
						total: connection.backfillTotalTypes
					})}
				</span>
				<Progress
					value={connection.backfillCompletedTypes}
					max={Math.max(connection.backfillTotalTypes, 1)}
					aria-labelledby="health-sync-progress"
				/>
			</Alert.Description>
		</Alert.Root>
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
			<Alert.Description class="flex flex-wrap items-center justify-between gap-3">
				<span>{m.google_health_action_required_description()}</span>
				<a
					href={resolve('/dashboard/import')}
					class={buttonVariants({ variant: 'outline', size: 'sm' })}
				>
					{m.google_health_review_access()}
				</a>
			</Alert.Description>
		</Alert.Root>
	{:else if connection.status === 'disconnected'}
		<Alert.Root>
			<InfoIcon aria-hidden="true" />
			<Alert.Title>{m.google_health_retained_title()}</Alert.Title>
			<Alert.Description>{m.google_health_retained_description()}</Alert.Description>
		</Alert.Root>
	{:else if connection.status === 'deleting'}
		<Alert.Root>
			<InfoIcon aria-hidden="true" />
			<Alert.Title>{m.google_health_status_deleting()}</Alert.Title>
			<Alert.Description>{m.google_health_deleting_description()}</Alert.Description>
		</Alert.Root>
	{:else}
		<div
			class="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
		>
			<Badge variant="secondary">{m.google_health_status_connected()}</Badge>
			<span>
				{connection.lastSuccessfulSyncAt === undefined
					? m.health_sync_never()
					: m.health_sync_active({ date: formatDateLong(connection.lastSuccessfulSyncAt) })}
			</span>
		</div>
	{/if}
{/if}
