<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { getConnectionStatus } from '#lib/remote/health.remote.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { formatDateLong } from '#lib/format.js';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';

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

	// One quiet line under the page header. States that need the reader are told apart by their
	// wording, a mark and an action, never by a tinted box.
	const LINE = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule py-2.5 text-sm';
	const ACTION =
		'ml-auto font-medium whitespace-nowrap underline decoration-rule-2 underline-offset-4 transition-colors duration-(--dur-micro) hover:decoration-sun';
</script>

{#snippet warningMark()}
	<AlertCircleIcon class="size-4 shrink-0 self-center text-ink-2" aria-hidden="true" />
{/snippet}

{#if !page.data.googleHealthEnabled}
	<!-- The optional integration is not configured on this server. -->
{:else if isLoading}
	<div class="border-b border-rule py-2.5" aria-busy="true">
		<Skeleton class="h-5 w-80 max-w-full" />
	</div>
{:else if connectionQuery.error !== undefined}
	<div class={LINE} role="alert">
		{@render warningMark()}
		<span class="font-medium">{m.health_query_error_title()}</span>
		<span class="text-ink-3">{m.health_query_error_description()}</span>
	</div>
{:else if connection === null}
	<div class={LINE} role="status">
		<span class="font-medium">{m.google_health_status_not_connected()}</span>
		<span class="text-ink-3">{m.google_health_not_connected_description()}</span>
		<a href={resolve('/dashboard/import')} class={ACTION}>{m.google_health_connect()}</a>
	</div>
{:else if connection !== undefined}
	{#if connection.status === 'connecting' || connection.status === 'backfilling'}
		<div class={LINE} role="status">
			<span class="font-medium">{m.google_health_importing_title()}</span>
			<span class="text-ink-3">{m.google_health_importing_description()}</span>
			<span class="ml-auto flex items-center gap-3 self-center">
				<span id="health-sync-progress" class="whitespace-nowrap text-ink-2">
					{m.google_health_progress({
						completed: connection.backfillCompletedTypes,
						total: connection.backfillTotalTypes
					})}
				</span>
				<Progress
					value={connection.backfillCompletedTypes}
					max={Math.max(connection.backfillTotalTypes, 1)}
					aria-labelledby="health-sync-progress"
					class="w-28 rounded-none bg-rule"
				/>
			</span>
		</div>
	{:else if connection.status === 'delayed'}
		<div class={LINE} role="status">
			<span class="font-medium">{m.google_health_delayed_title()}</span>
			<span class="text-ink-3">{m.google_health_delayed_description()}</span>
		</div>
	{:else if connection.status === 'action_required'}
		<div class={LINE} role="alert">
			{@render warningMark()}
			<span class="font-medium">{m.google_health_action_required_title()}</span>
			<span class="text-ink-3">{m.google_health_action_required_description()}</span>
			<a href={resolve('/dashboard/import')} class={ACTION}>{m.google_health_review_access()}</a>
		</div>
	{:else if connection.status === 'disconnected'}
		<div class={LINE} role="status">
			<span class="font-medium">{m.google_health_retained_title()}</span>
			<span class="text-ink-3">{m.google_health_retained_description()}</span>
		</div>
	{:else if connection.status === 'deleting'}
		<div class={LINE} role="status">
			<span class="font-medium">{m.google_health_status_deleting()}</span>
			<span class="text-ink-3">{m.google_health_deleting_description()}</span>
		</div>
	{:else}
		<div class={LINE}>
			<span class="font-medium">{m.google_health_status_connected()}</span>
			<span class="text-ink-3">
				{connection.lastSuccessfulSyncAt === undefined
					? m.health_sync_never()
					: m.health_sync_active({ date: formatDateLong(connection.lastSuccessfulSyncAt) })}
			</span>
		</div>
	{/if}
{/if}
