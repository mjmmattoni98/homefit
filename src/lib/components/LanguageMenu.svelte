<script lang="ts">
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale, isLocale, locales, setLocale } from '#lib/paraglide/runtime.js';
	import LanguagesIcon from '@lucide/svelte/icons/languages';

	let { side = 'right' }: { side?: 'top' | 'right' | 'bottom' | 'left' } = $props();

	const NAMES: Record<string, string> = { en: 'English', es: 'Español' };
</script>

<!-- A compact language picker for places too narrow for LanguageSwitcher. -->
<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		aria-label={m.language_label()}
		title={m.language_label()}
	>
		<LanguagesIcon />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content {side} align="end" class="w-40">
		<DropdownMenu.Label>{m.language_label()}</DropdownMenu.Label>
		<DropdownMenu.RadioGroup
			value={getLocale()}
			onValueChange={(locale) => {
				if (isLocale(locale)) setLocale(locale);
			}}
		>
			{#each locales as locale (locale)}
				<DropdownMenu.RadioItem value={locale} lang={locale}>
					{NAMES[locale] ?? locale}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
