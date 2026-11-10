<script lang="ts">
	import type { ConnectionStatusView } from '#lib/server/google-health/connection.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { formatDate } from '#lib/format.js';
	import { metricLabel, syncErrorLabel } from '#lib/google-health/labels.js';
	import * as m from '#lib/paraglide/messages.js';

	let { connection, compact = false }: { connection: ConnectionStatusView; compact?: boolean } =
		$props();
	const issues = $derived(connection.syncIssues ?? []);
	const retryTime = (timestamp: number) =>
		formatDate(timestamp, {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
			timeZoneName: 'short'
		});
</script>

<div class="flex min-w-0 flex-col gap-2 text-sm text-ink-3">
	{#if connection.backfillTotalTypes > 0 && (connection.backfillCompletedTypes < connection.backfillTotalTypes || issues.length > 0)}
		<div class="flex flex-wrap items-center gap-3">
			<span
				>{m.google_health_progress({
					completed: connection.backfillCompletedTypes,
					total: connection.backfillTotalTypes
				})}</span
			>
			<Progress
				value={connection.backfillCompletedTypes}
				max={Math.max(connection.backfillTotalTypes, 1)}
				aria-label={m.google_health_importing_title()}
				class="w-28 rounded-none bg-rule"
			/>
		</div>
	{/if}
	{#if connection.sharedRetryAt !== undefined}
		<p>{m.google_health_shared_retry({ date: retryTime(connection.sharedRetryAt) })}</p>
	{:else if issues.some((issue) => issue.status === 'retry')}
		<p>{m.google_health_partial_retry()}</p>
	{/if}
	{#if !compact && issues.length > 0}
		<ul class="flex flex-col gap-2">
			{#each issues as issue (`${issue.dataType}:${issue.mode}`)}
				<li class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span class="font-medium text-ink-2">{metricLabel(issue.dataType)}</span>
					{#if issue.errorCode}
						<span>{syncErrorLabel(issue.errorCode)}</span>
						<code class="text-xs">{issue.errorCode}</code>
					{/if}
					<span>{m.google_health_retry_attempts({ count: issue.attempts })}</span>
					<span>
						{issue.status === 'failed'
							? m.google_health_metric_failed()
							: issue.nextRetryAt !== undefined
								? m.google_health_next_retry({ date: retryTime(issue.nextRetryAt) })
								: m.google_health_retry_pending()}
					</span>
				</li>
			{/each}
		</ul>
	{:else if compact && issues.length > 0 && connection.nextRetryAt !== undefined}
		<p>{m.google_health_next_retry({ date: retryTime(connection.nextRetryAt) })}</p>
	{/if}
</div>
