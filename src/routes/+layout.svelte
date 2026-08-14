<script lang="ts">
	import { ClerkProvider } from 'svelte-clerk';
	import { shadcn } from '@clerk/ui/themes';
	import { setupConvex } from 'convex-svelte';
	import { PUBLIC_CONVEX_URL } from '$env/static/public';
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '$lib/components/ui/sonner';
	import ConvexAuth from '$lib/components/ConvexAuth.svelte';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	setupConvex(PUBLIC_CONVEX_URL);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>

<ModeWatcher />

<ClerkProvider appearance={{ theme: shadcn }}>
	<ConvexAuth>
		{@render children()}
	</ConvexAuth>
</ClerkProvider>

<Toaster richColors closeButton />
