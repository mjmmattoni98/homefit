'use node';

import { v } from 'convex/values';
import { env, internalAction } from '../_generated/server';
import { revokeGoogleToken } from './apiClient';
import { createTokenKeyring, decryptRefreshToken } from './crypto';

export const revokeToken = internalAction({
	args: {
		userId: v.string(),
		encryptedRefreshToken: v.string(),
		tokenNonce: v.string(),
		tokenTag: v.string(),
		tokenKeyVersion: v.string()
	},
	returns: v.null(),
	handler: async (_ctx, args) => {
		try {
			const keyring = createTokenKeyring(
				env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
				env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
				env.GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS
			);
			const { refreshToken } = await decryptRefreshToken(args, args.userId, keyring);
			await revokeGoogleToken(refreshToken);
		} catch {
			// Local invalidation already committed; remote revocation is best effort.
		}
		return null;
	}
});
