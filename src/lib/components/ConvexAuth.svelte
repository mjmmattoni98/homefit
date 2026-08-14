<script lang="ts">
	import { setupAuth } from 'convex-svelte';
	import { useClerkContext } from 'svelte-clerk';
	import type { Snippet } from 'svelte';

	let { children }: { children?: Snippet } = $props();

	const clerk = useClerkContext();

	setupAuth(() => ({
		isLoading: !clerk.isLoaded,
		isAuthenticated: clerk.auth.userId != null,
		fetchAccessToken: async ({ forceRefreshToken }) => {
			if (!clerk.session) return null;
			try {
				const token = await clerk.session.getToken({
					template: 'convex',
					skipCache: forceRefreshToken
				});
				if (!token) {
					console.warn(
						'[ConvexAuth] Clerk returned no token for the "convex" JWT template. ' +
							'Create it in the Clerk dashboard (JWT Templates → Convex).'
					);
				}
				return token;
			} catch (error) {
				console.warn(
					'[ConvexAuth] Could not fetch the "convex" JWT from Clerk. ' +
						'Make sure a JWT template named "convex" exists in your Clerk dashboard.',
					error
				);
				return null;
			}
		}
	}));
</script>

{@render children?.()}
