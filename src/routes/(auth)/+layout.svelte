<script lang="ts">
	import SiteHeader from '#lib/components/SiteHeader.svelte';

	let { children } = $props();
</script>

<SiteHeader />

<main class="flex min-h-[calc(100svh-3.5rem)] items-center justify-center px-4 py-12">
	<div class="w-full max-w-sm">
		{@render children()}
	</div>
</main>
