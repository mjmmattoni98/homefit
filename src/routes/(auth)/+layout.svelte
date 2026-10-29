<script lang="ts">
	import SiteHeader from '#lib/components/SiteHeader.svelte';

	let { children } = $props();
</script>

<SiteHeader />

<!-- The form sits on the horizon: day above it, the night field below. -->
<main
	class="relative flex min-h-[calc(100svh-var(--bar-height))] items-center justify-center px-4 py-12"
>
	<div class="absolute inset-x-0 bottom-0 h-1/2 bg-night" aria-hidden="true"></div>
	<div class="relative w-full max-w-sm">
		{@render children()}
	</div>
</main>
