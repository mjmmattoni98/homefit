<script lang="ts">
	import { resolve } from '$app/paths';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import CommandPalette, { type PaletteItem } from '#lib/components/CommandPalette.svelte';
	import LanguageMenu from '#lib/components/LanguageMenu.svelte';
	import LanguageSwitcher from '#lib/components/LanguageSwitcher.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import UserMenu from '#lib/components/UserMenu.svelte';
	import Wordmark from '#lib/components/Wordmark.svelte';
	import { categoryLabel } from '#lib/google-health/labels.js';
	import { getCategories } from '#lib/remote/health.remote.js';
	import * as m from '#lib/paraglide/messages.js';
	import { cn } from '#lib/utils.js';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import HeartPulseIcon from '@lucide/svelte/icons/heart-pulse';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import SearchIcon from '@lucide/svelte/icons/search';
	import MenuIcon from '@lucide/svelte/icons/menu';
	import type { Component } from 'svelte';

	let { children } = $props();

	type Section = {
		href: '/dashboard' | '/dashboard/exercises' | '/dashboard/health' | '/dashboard/import';
		label: string;
		icon: Component;
	};

	const categoriesQuery = getCategories();
	const categories = $derived(categoriesQuery.current ?? []);
	// Health views stay reachable for previously imported data even if Google Health is turned off.
	const showHealth = $derived(page.data.googleHealthEnabled || categories.length > 0);
	const user = $derived(page.data.user);
	const currentPath = $derived(page.url.pathname);

	const sections = $derived<Section[]>([
		{ href: '/dashboard', label: m.nav_overview(), icon: LayoutDashboardIcon },
		{ href: '/dashboard/exercises', label: m.nav_exercises(), icon: DumbbellIcon },
		...(showHealth
			? [{ href: '/dashboard/health' as const, label: m.nav_health(), icon: HeartPulseIcon }]
			: [])
	]);
	// Importing is occasional, so it sits apart from the views.
	const importSection = $derived<Section>({
		href: '/dashboard/import',
		label: m.nav_import(),
		icon: UploadIcon
	});

	function isActive(href: Section['href']): boolean {
		const target = resolve(href);
		return href === '/dashboard' ? currentPath === target : currentPath.startsWith(target);
	}

	const paletteItems = $derived<PaletteItem[]>([
		...[...sections, importSection].map((section) => ({
			label: section.label,
			icon: section.icon,
			onselect: () => goto(resolve(section.href))
		})),
		...(showHealth
			? [
					...categories.map((item) => ({
						label: `${m.nav_health()}: ${categoryLabel(item.category)}`,
						icon: HeartPulseIcon,
						onselect: () =>
							goto(resolve('/dashboard/health/[category]', { category: item.category }))
					})),
					{
						label: `${m.nav_health()}: ${m.nav_all_metrics()}`,
						icon: HeartPulseIcon,
						onselect: () => goto(resolve('/dashboard/health/metrics'))
					}
				]
			: [])
	]);

	let paletteOpen = $state(false);
	let menuOpen = $state(false);

	// On small screens the menu is a sheet over the page; close it once a link is followed.
	afterNavigate(() => (menuOpen = false));
</script>

{#snippet barLink(section: Section)}
	{@const active = isActive(section.href)}
	<a
		href={resolve(section.href)}
		aria-current={active ? 'page' : undefined}
		class={cn(
			'flex items-center px-3 text-[0.9375rem] whitespace-nowrap text-ink-3 transition-colors duration-(--dur-micro) hover:text-foreground',
			active && 'text-foreground shadow-[inset_0_-2px_0_var(--color-sun)]'
		)}
	>
		{section.label}
	</a>
{/snippet}

{#snippet menuLink(section: Section)}
	{@const active = isActive(section.href)}
	<a
		href={resolve(section.href)}
		aria-current={active ? 'page' : undefined}
		class={cn(
			'flex items-center gap-3 border-l-2 border-transparent py-2.5 pl-4 text-base text-ink-2 transition-colors duration-(--dur-micro) hover:text-foreground',
			active && 'border-sun text-foreground'
		)}
	>
		<section.icon class="size-[18px] text-ink-3" aria-hidden="true" />
		{section.label}
	</a>
{/snippet}

<div class="flex min-h-svh flex-col">
	<header class="sticky top-0 z-30 border-b border-rule bg-day">
		<div
			class="mx-auto flex h-(--bar-height) w-full max-w-(--container) items-stretch gap-2 px-4 md:gap-6 md:px-8"
		>
			<button
				type="button"
				class="-ml-2 flex size-11 items-center justify-center self-center rounded-(--radius-control) text-ink-2 hover:bg-day-2 hover:text-foreground md:hidden"
				aria-label={m.nav_open_menu()}
				onclick={() => (menuOpen = true)}
			>
				<MenuIcon class="size-5" />
			</button>
			<a
				href={resolve('/dashboard')}
				class="flex items-center self-stretch"
				aria-label={m.app_name()}
			>
				<Wordmark />
			</a>
			<nav class="hidden items-stretch md:flex" aria-label={m.nav_main_label()}>
				{#each sections as section (section.href)}
					{@render barLink(section)}
				{/each}
				{@render barLink(importSection)}
			</nav>

			<div class="ml-auto flex items-center gap-1">
				<button
					type="button"
					class="flex h-9 items-center gap-2 rounded-(--radius-control) px-2.5 text-sm text-ink-3 transition-colors duration-(--dur-micro) hover:text-foreground sm:w-60 sm:border sm:border-rule-2 sm:hover:border-field-edge"
					aria-label={m.command_search()}
					aria-keyshortcuts="Control+K Meta+K"
					onclick={() => (paletteOpen = true)}
				>
					<SearchIcon class="size-4" />
					<span class="hidden sm:inline">{m.command_search()}</span>
					<Kbd class="ml-auto hidden sm:inline-flex">⌘K</Kbd>
				</button>
				<div class="hidden items-center md:flex">
					<ThemeToggle />
					<LanguageMenu side="bottom" />
				</div>
				{#if user}
					<UserMenu {user} />
				{/if}
			</div>
		</div>
	</header>

	<main class="page-grid flex-1 pb-20">
		{@render children()}
	</main>
</div>

<Sheet.Root bind:open={menuOpen}>
	<Sheet.Content side="left" class="w-72 gap-0 bg-day">
		<Sheet.Header class="border-b border-rule">
			<Sheet.Title><Wordmark /></Sheet.Title>
		</Sheet.Header>
		<nav class="flex flex-col overflow-y-auto py-3" aria-label={m.nav_main_label()}>
			{#each sections as section (section.href)}
				{@render menuLink(section)}
				{#if section.href === '/dashboard/health'}
					{#each categories as item (item.category)}
						{@const href = resolve('/dashboard/health/[category]', { category: item.category })}
						<a
							{href}
							aria-current={currentPath === href ? 'page' : undefined}
							class={cn(
								'ml-[1.125rem] flex items-center border-l border-rule py-2 pr-4 pl-[1.625rem] text-sm text-ink-3 hover:text-foreground',
								currentPath === href && 'border-sun text-foreground'
							)}
						>
							{categoryLabel(item.category)}
							<span class="ml-auto text-xs">{item.count}</span>
						</a>
					{/each}
				{/if}
			{/each}
			<div class="my-3 border-t border-rule"></div>
			{@render menuLink(importSection)}
		</nav>
		<div class="mt-auto flex items-center justify-between gap-2 border-t border-rule p-3">
			<ThemeToggle />
			<LanguageSwitcher />
		</div>
	</Sheet.Content>
</Sheet.Root>

<CommandPalette bind:open={paletteOpen} pages={paletteItems} />
