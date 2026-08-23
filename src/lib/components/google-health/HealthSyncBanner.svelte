<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { api } from '$convex/_generated/api';
	import { useAuth, useQuery } from 'convex-svelte';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Progress } from '$lib/components/ui/progress';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages';
	import { formatDateLong } from '$lib/format';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import InfoIcon from '@lucide/svelte/icons/info';

	const auth = useAuth();
	const connectionQuery = useQuery(api.googleHealth.model.getConnectionStatus, () =>
		auth.isAuthenticated ? {} : 'skip'
	);

	const connection = $derived(connectionQuery.data);
	const isLoading = $derived(auth.isLoading || !auth.isAuthenticated || connectionQuery.isLoading);
</script>

{#if isLoading}
	<Skeleton class="h-14 w-full" />
{:else if connectionQuery.error}
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
			<a href={resolve('/dashboard/import' as Pathname)} class={buttonVariants({ size: 'sm' })}>
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
					href={resolve('/dashboard/import' as Pathname)}
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
