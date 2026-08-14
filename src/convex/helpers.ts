import type { ActionCtx, MutationCtx, QueryCtx } from './_generated/server';

/**
 * Returns the authenticated user's stable identifier (Clerk tokenIdentifier)
 * or throws when the request is not authenticated.
 */
export async function requireUserId(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (!identity) {
		throw new Error('Not authenticated');
	}
	return identity.tokenIdentifier;
}
