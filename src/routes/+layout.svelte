<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import './layout.css';
	import favicon from '#lib/assets/favicon.png';
	import touchIcon from '#lib/assets/apple-touch-icon.png';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/png" sizes="32x32" href={favicon} />
	<link rel="apple-touch-icon" sizes="180x180" href={touchIcon} />
</svelte:head>

<ModeWatcher />

{@render children()}

<Toaster richColors closeButton />
