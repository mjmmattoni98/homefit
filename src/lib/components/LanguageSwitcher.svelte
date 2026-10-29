<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale, setLocale, locales } from '#lib/paraglide/runtime.js';
	import { cn } from '#lib/utils.js';

	const labels: Record<string, string> = { en: 'EN', es: 'ES' };
	const names: Record<string, string> = { en: 'English', es: 'Español' };
</script>

<div
	class="flex items-center gap-1 text-sm shadow-[inset_0_-1px_0_var(--color-rule)]"
	role="group"
	aria-label={m.language_label()}
>
	{#each locales as locale (locale)}
		<button
			type="button"
			onclick={() => setLocale(locale)}
			aria-pressed={getLocale() === locale}
			title={names[locale]}
			lang={locale}
			class={cn(
				'h-8 px-2.5 whitespace-nowrap transition-colors duration-(--dur-micro)',
				getLocale() === locale
					? 'text-foreground shadow-[inset_0_-2px_0_var(--color-sun)]'
					: 'text-ink-3 hover:text-foreground'
			)}
		>
			{labels[locale] ?? locale.toUpperCase()}
		</button>
	{/each}
</div>
