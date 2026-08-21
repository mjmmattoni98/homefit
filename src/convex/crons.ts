import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

crons.cron(
	'reconcile Google Health',
	'15 3 * * *',
	internal.googleHealth.maintenance.scheduleDailyReconciliation,
	{}
);
crons.cron(
	'clean Google Health operational data',
	'15 4 * * *',
	internal.googleHealth.maintenance.cleanupOperationalData,
	{}
);

export default crons;
