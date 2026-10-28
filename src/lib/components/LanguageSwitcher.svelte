<script lang="ts">
	import * as m from '#lib/paraglide/messages.js';
	import { getLocale, setLocale, locales } from '#lib/paraglide/runtime.js';
	import { cn } from '#lib/utils.js';

	const labels: Record<string, string> = { en: 'EN', es: 'ES' };
	const names: Record<string, string> = { en: 'English', es: 'Español' };
</script>

<div
	class="flex items-center gap-0.5 rounded-md border border-border p-0.5 text-xs font-medium"
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
				'rounded-sm px-2 py-1 transition-colors',
				getLocale() === locale
					? 'bg-primary text-primary-foreground'
					: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
			)}
		>
			{labels[locale] ?? locale.toUpperCase()}
		</button>
	{/each}
</div>
