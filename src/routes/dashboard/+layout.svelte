<script lang="ts">
	import { resolve } from '$app/paths';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import CommandPalette, { type PaletteItem } from '#lib/components/CommandPalette.svelte';
	import LanguageMenu from '#lib/components/LanguageMenu.svelte';
	import LanguageSwitcher from '#lib/components/LanguageSwitcher.svelte';
	import ThemeToggle from '#lib/components/ThemeToggle.svelte';
	import UserMenu from '#lib/components/UserMenu.svelte';
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

	const title = $derived(
		[...sections, importSection].find((section) => isActive(section.href))?.label ?? ''
	);

	const paletteItems = $derived<PaletteItem[]>([
		...[...sections, importSection].map((section) => ({
			label: section.label,
			icon: section.icon,
			onselect: () => goto(resolve(section.href))
		})),
		...(showHealth
			? [
					...categories.map((item) => ({
						label: `${m.nav_health()} · ${categoryLabel(item.category)}`,
						icon: HeartPulseIcon,
						onselect: () =>
							goto(resolve('/dashboard/health/[category]', { category: item.category }))
					})),
					{
						label: `${m.nav_health()} · ${m.nav_all_metrics()}`,
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

{#snippet railLink(section: Section)}
	{@const active = isActive(section.href)}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<a
					{...props}
					href={resolve(section.href)}
					aria-label={section.label}
					aria-current={active ? 'page' : undefined}
					class={cn(
						'relative flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
						active && 'bg-accent text-foreground'
					)}
				>
					{#if active}
						<span class="absolute top-2 -left-2 h-6 w-1 rounded-r bg-primary" aria-hidden="true"
						></span>
					{/if}
					<section.icon class="size-5" />
				</a>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="right" sideOffset={8}>{section.label}</Tooltip.Content>
	</Tooltip.Root>
{/snippet}

{#snippet menuLink(section: Section)}
	{@const active = isActive(section.href)}
	<a
		href={resolve(section.href)}
		aria-current={active ? 'page' : undefined}
		class={cn(
			'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
			active && 'bg-accent text-foreground'
		)}
	>
		<section.icon class="size-5" />
		{section.label}
	</a>
{/snippet}

<Tooltip.Provider delayDuration={150}>
	<div class="flex min-h-svh">
		<nav
			class="fixed inset-y-0 left-0 z-40 hidden w-14 flex-col items-center gap-1 border-r bg-sidebar py-3 md:flex"
			aria-label={m.nav_main_label()}
		>
			<a
				href={resolve('/dashboard')}
				class="mb-3 flex size-9 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground"
				aria-label={m.app_name()}
			>
				HF
			</a>
			<div class="flex flex-col items-center gap-1">
				{#each sections as section (section.href)}
					{@render railLink(section)}
				{/each}
			</div>
			<div class="mt-auto flex flex-col items-center gap-1">
				{@render railLink(importSection)}
				<ThemeToggle />
				<LanguageMenu />
				{#if user}
					<UserMenu {user} />
				{/if}
			</div>
		</nav>

		<div class="flex min-w-0 flex-1 flex-col md:pl-14">
			<header
				class="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur md:px-6"
			>
				<button
					type="button"
					class="-ml-1 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
					aria-label={m.nav_open_menu()}
					onclick={() => (menuOpen = true)}
				>
					<MenuIcon class="size-5" />
				</button>
				<nav aria-label={m.nav_breadcrumb()} class="flex min-w-0 items-center gap-1.5 text-sm">
					<a href={resolve('/dashboard')} class="text-muted-foreground hover:text-foreground">
						{m.app_name()}
					</a>
					{#if title}
						<span class="text-muted-foreground/60" aria-hidden="true">/</span>
						<span class="truncate font-medium" aria-current="page">{title}</span>
					{/if}
				</nav>
				<button
					type="button"
					class="ml-auto flex h-8 items-center gap-2 rounded-md border bg-muted/40 px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:w-72"
					aria-label={m.command_search()}
					aria-keyshortcuts="Control+K Meta+K"
					onclick={() => (paletteOpen = true)}
				>
					<SearchIcon class="size-4" />
					<span class="hidden sm:inline">{m.command_search()}</span>
					<Kbd class="ml-auto hidden sm:inline-flex">⌘K</Kbd>
				</button>
				{#if user}
					<div class="md:hidden"><UserMenu {user} /></div>
				{/if}
			</header>

			<main class="flex-1 px-4 pt-4 pb-8 md:px-6">
				{@render children()}
			</main>
		</div>
	</div>
</Tooltip.Provider>

<Sheet.Root bind:open={menuOpen}>
	<Sheet.Content side="left" class="w-72">
		<Sheet.Header>
			<Sheet.Title>{m.app_name()}</Sheet.Title>
		</Sheet.Header>
		<nav class="flex flex-col gap-1 overflow-y-auto px-3" aria-label={m.nav_main_label()}>
			{#each sections as section (section.href)}
				{@render menuLink(section)}
				{#if section.href === '/dashboard/health'}
					{#each categories as item (item.category)}
						{@const href = resolve('/dashboard/health/[category]', { category: item.category })}
						<a
							{href}
							aria-current={currentPath === href ? 'page' : undefined}
							class={cn(
								'ml-11 flex items-center rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground',
								currentPath === href && 'bg-accent text-foreground'
							)}
						>
							{categoryLabel(item.category)}
							<span class="ml-auto text-xs tabular-nums">{item.count}</span>
						</a>
					{/each}
				{/if}
			{/each}
			<div class="my-2 border-t"></div>
			{@render menuLink(importSection)}
		</nav>
		<div class="mt-auto flex items-center justify-between gap-2 border-t p-3">
			<ThemeToggle />
			<LanguageSwitcher />
		</div>
	</Sheet.Content>
</Sheet.Root>

<CommandPalette bind:open={paletteOpen} pages={paletteItems} />
