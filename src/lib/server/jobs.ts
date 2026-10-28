import { PgBoss, type Job } from 'pg-boss';
import type { Database } from './db/types';
import type { GoogleHealthConfig } from './google-health/config';
import { deleteConnectionDataBatch, findPendingDeletions } from './google-health/connection';
import { cleanupOperationalData, queueDailyReconciliation } from './google-health/maintenance';
import { findDueConnections, syncConnection } from './google-health/sync';
import { processDelivery, rescheduleStrandedDeliveries } from './google-health/webhook';

const QUEUE = {
	sync: 'google-health-sync',
	webhook: 'google-health-webhook',
	delete: 'google-health-delete',
	dispatch: 'google-health-dispatch',
	reconcile: 'google-health-reconcile',
	cleanup: 'google-health-cleanup'
} as const;

const DELETE_BUDGET_MS = 60_000;

let boss: PgBoss | null = null;

export interface JobsOptions {
	connectionString: string;
	db: Database;
	googleHealth: GoogleHealthConfig;
	/** Process jobs in this instance. When false, the instance only enqueues work. */
	worker: boolean;
}

/** Starts the Postgres-backed job queue that drives the Google Health integration. */
export async function startJobs(options: JobsOptions): Promise<void> {
	if (boss !== null) return;
	const instance = new PgBoss({
		connectionString: options.connectionString,
		schema: 'pgboss',
		max: 4,
		application_name: 'homefit-jobs',
		schedule: options.worker,
		supervise: options.worker
	});
	instance.on('error', (error) => console.error('[jobs]', error));
	await instance.start();
	// One queued and one active sync job per connection: a request that arrives while a job runs
	// is picked up by the queued one, which sees every cursor queued in the meantime.
	await instance.createQueue(QUEUE.sync, { policy: 'stately', expireInSeconds: 15 * 60 });
	await instance.createQueue(QUEUE.delete, { policy: 'stately' });
	await instance.createQueue(QUEUE.webhook);
	for (const name of [QUEUE.dispatch, QUEUE.reconcile, QUEUE.cleanup]) {
		await instance.createQueue(name, { policy: 'singleton' });
	}
	await instance.updateQueue(QUEUE.sync, { retryLimit: 3, retryDelay: 30, retryBackoff: true });
	await instance.updateQueue(QUEUE.delete, { retryLimit: 10, retryDelay: 10, retryBackoff: true });
	// Signing keys may be briefly unavailable. Google never resends an acknowledged delivery, so
	// once these retries run out the dispatcher resumes it until the retention horizon.
	await instance.updateQueue(QUEUE.webhook, {
		retryLimit: 16,
		retryDelay: 30,
		retryBackoff: true,
		retryDelayMax: 60 * 60
	});
	boss = instance;
	if (!options.worker) return;

	const { db, googleHealth: config } = options;
	await instance.schedule(QUEUE.dispatch, '* * * * *');
	await instance.schedule(QUEUE.reconcile, '15 3 * * *');
	await instance.schedule(QUEUE.cleanup, '15 4 * * *');

	await instance.work<{ connectionId: string }>(
		QUEUE.sync,
		{ localConcurrency: 2 },
		async ([job]: Job<{ connectionId: string }>[]) => {
			const more = await syncConnection({ db, config }, job.data.connectionId);
			if (more) await requestSync(job.data.connectionId);
		}
	);
	// A KeysetUnavailableError (or any other failure) leaves the delivery queued for a retry.
	await instance.work<{ deliveryId: string }>(QUEUE.webhook, async ([job]) => {
		for (const connectionId of await processDelivery(db, job.data.deliveryId)) {
			await requestSync(connectionId);
		}
	});
	await instance.work<{ connectionId: string; generation: number }>(QUEUE.delete, async ([job]) => {
		const deadline = Date.now() + DELETE_BUDGET_MS;
		while (Date.now() < deadline) {
			const result = await deleteConnectionDataBatch(
				db,
				job.data.connectionId,
				job.data.generation
			);
			if (result !== 'continue') return;
		}
		await requestDeletion(job.data.connectionId, job.data.generation);
	});
	// Safety net for work whose job was never enqueued or ran out of retries.
	await instance.work(QUEUE.dispatch, async () => {
		for (const connectionId of await findDueConnections(db)) await requestSync(connectionId);
		for (const { connectionId, generation } of await findPendingDeletions(db)) {
			await requestDeletion(connectionId, generation);
		}
		for (const deliveryId of await rescheduleStrandedDeliveries(db)) {
			await requestWebhookProcessing(deliveryId);
		}
	});
	await instance.work(QUEUE.reconcile, async () => {
		for (const connectionId of await queueDailyReconciliation(db)) await requestSync(connectionId);
	});
	await instance.work(QUEUE.cleanup, async () => {
		const result = await cleanupOperationalData(db);
		console.info('[jobs] Google Health cleanup', result);
	});
}

export async function stopJobs(): Promise<void> {
	const instance = boss;
	boss = null;
	await instance?.stop({ graceful: true, timeout: 20_000 });
}

function requireBoss(): PgBoss {
	if (boss === null) throw new Error('Background jobs are not running');
	return boss;
}

/** Requests a sync of the connection's queued work (deduplicated per connection). */
export async function requestSync(connectionId: string): Promise<void> {
	await requireBoss().send(QUEUE.sync, { connectionId }, { singletonKey: connectionId });
}

export async function requestWebhookProcessing(deliveryId: string): Promise<void> {
	await requireBoss().send(QUEUE.webhook, { deliveryId });
}

export async function requestDeletion(connectionId: string, generation: number): Promise<void> {
	await requireBoss().send(
		QUEUE.delete,
		{ connectionId, generation },
		{ singletonKey: connectionId }
	);
}
