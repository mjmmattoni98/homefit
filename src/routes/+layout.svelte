<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import './layout.css';
	import favicon from '#lib/assets/favicon.png?no-inline';
	import touchIcon from '#lib/assets/apple-touch-icon.png';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="manifest" href="/manifest.webmanifest" />

	<link rel="icon" type="image/png" sizes="32x32" href={favicon} />
	<link rel="apple-touch-icon" sizes="180x180" href={touchIcon} />
	<!-- Without its own head script, ModeWatcher renders the theme-color meta where it stands.
	     The colours are --color-day of each theme (tokens.css) as hex, which every browser's
	     meta parser reads; src/app.html sets the same pair before hydration. -->
	<ModeWatcher disableHeadScriptInjection themeColors={{ light: '#f5f7f9', dark: '#121721' }} />
</svelte:head>

{@render children()}

<Toaster richColors closeButton />
