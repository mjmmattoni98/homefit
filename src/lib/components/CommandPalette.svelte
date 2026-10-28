<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface PaletteItem {
		label: string;
		icon: Component;
		onselect: () => void;
	}
</script>

<script lang="ts">
	import { toggleMode } from 'mode-watcher';
	import * as Command from '#lib/components/ui/command/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale, locales, setLocale } from '#lib/paraglide/runtime.js';
	import LanguagesIcon from '@lucide/svelte/icons/languages';
	import SunMoonIcon from '@lucide/svelte/icons/sun-moon';

	let { open = $bindable(false), pages }: { open?: boolean; pages: PaletteItem[] } = $props();

	const NAMES: Record<string, string> = { en: 'English', es: 'Español' };

	function run(action: () => void): void {
		open = false;
		action();
	}

	function onkeydown(event: KeyboardEvent): void {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			open = !open;
		}
	}
</script>

<svelte:window {onkeydown} />

<Command.Dialog bind:open title={m.command_title()} description={m.command_description()}>
	<Command.Input placeholder={m.command_placeholder()} />
	<Command.List>
		<Command.Empty>{m.command_empty()}</Command.Empty>
		<Command.Group heading={m.command_group_pages()}>
			{#each pages as page (page.label)}
				<Command.Item value={page.label} onSelect={() => run(page.onselect)}>
					<page.icon />
					{page.label}
				</Command.Item>
			{/each}
		</Command.Group>
		<Command.Separator />
		<Command.Group heading={m.command_group_actions()}>
			<Command.Item value={m.theme_toggle()} onSelect={() => run(toggleMode)}>
				<SunMoonIcon />
				{m.theme_toggle()}
			</Command.Item>
			{#each locales.filter((locale) => locale !== getLocale()) as locale (locale)}
				{@const label = m.command_language({ language: NAMES[locale] ?? locale })}
				<Command.Item value={label} onSelect={() => run(() => setLocale(locale))}>
					<LanguagesIcon />
					{label}
				</Command.Item>
			{/each}
		</Command.Group>
	</Command.List>
</Command.Dialog>
