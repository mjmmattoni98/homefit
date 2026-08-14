import { v } from 'convex/values';
import { query } from '../_generated/server';
import { requireUserId } from '../helpers';
import { connectionStatusValidator } from './validators';

const connectionStatusResultValidator = v.object({
	status: connectionStatusValidator,
	grantedScopes: v.array(v.string()),
	backfillTotalTypes: v.number(),
	backfillCompletedTypes: v.number(),
	lastAttemptAt: v.optional(v.number()),
	lastSuccessfulSyncAt: v.optional(v.number()),
	lastErrorCode: v.optional(v.string()),
	lastErrorMessage: v.optional(v.string()),
	nextRetryAt: v.optional(v.number()),
	disconnectedAt: v.optional(v.number())
});

export const getConnectionStatus = query({
	args: {},
	returns: v.union(connectionStatusResultValidator, v.null()),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const connection = await ctx.db
			.query('googleHealthConnections')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();

		if (!connection) {
			return null;
		}

		return {
			status: connection.status,
			grantedScopes: connection.grantedScopes,
			backfillTotalTypes: connection.backfillTotalTypes,
			backfillCompletedTypes: connection.backfillCompletedTypes,
			...(connection.lastAttemptAt === undefined
				? {}
				: { lastAttemptAt: connection.lastAttemptAt }),
			...(connection.lastSuccessfulSyncAt === undefined
				? {}
				: { lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt }),
			...(connection.lastErrorCode === undefined
				? {}
				: { lastErrorCode: connection.lastErrorCode }),
			...(connection.lastErrorMessage === undefined
				? {}
				: { lastErrorMessage: connection.lastErrorMessage }),
			...(connection.nextRetryAt === undefined ? {} : { nextRetryAt: connection.nextRetryAt }),
			...(connection.disconnectedAt === undefined
				? {}
				: { disconnectedAt: connection.disconnectedAt })
		};
	}
});
