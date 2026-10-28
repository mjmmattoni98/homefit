<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Sidebar from '#lib/components/ui/sidebar/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import SidebarAutoClose from '#lib/components/SidebarAutoClose.svelte';
	import { categoryLabel } from '#lib/google-health/labels.js';
	import { getCategories } from '#lib/remote/health.remote.js';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import HeartPulseIcon from '@lucide/svelte/icons/heart-pulse';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import type { Component } from 'svelte';

	let { children } = $props();

	type NavItem = {
		href: '/dashboard' | '/dashboard/exercises' | '/dashboard/import';
		label: () => string;
		icon: Component;
	};

	const items: NavItem[] = [
		{ href: '/dashboard', label: () => m.nav_overview(), icon: LayoutDashboardIcon },
		{ href: '/dashboard/exercises', label: () => m.nav_exercises(), icon: DumbbellIcon },
		{ href: '/dashboard/import', label: () => m.nav_import(), icon: UploadIcon }
	];

	const categoriesQuery = getCategories();
	const categories = $derived(categoriesQuery.current ?? []);
	// Health views stay reachable for previously imported data even if Google Health is turned off.
	const showHealth = $derived(page.data.googleHealthEnabled || categories.length > 0);
	const currentPath = $derived(page.url.pathname);
</script>

{#snippet navItem(item: NavItem)}
	<Sidebar.MenuItem>
		<Sidebar.MenuButton isActive={currentPath === resolve(item.href)}>
			{#snippet child({ props })}
				<a href={resolve(item.href)} {...props}>
					<item.icon />
					<span>{item.label()}</span>
				</a>
			{/snippet}
		</Sidebar.MenuButton>
	</Sidebar.MenuItem>
{/snippet}

<Sidebar.Provider>
	<SidebarAutoClose />
	<Sidebar.Root collapsible="icon">
		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupLabel>{m.app_name()}</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each items.slice(0, 2) as item (item.href)}
							{@render navItem(item)}
						{/each}
						{#if showHealth}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={currentPath.startsWith(resolve('/dashboard/health'))}>
									{#snippet child({ props })}
										<a href={resolve('/dashboard/health')} {...props}>
											<HeartPulseIcon />
											<span>{m.nav_health()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
								<Sidebar.MenuSub>
									{#each categories as item (item.category)}
										{@const href = resolve('/dashboard/health/[category]', {
											category: item.category
										})}
										<Sidebar.MenuSubItem>
											<Sidebar.MenuSubButton {href} isActive={currentPath === href}>
												<span>{categoryLabel(item.category)}</span>
												<span class="ml-auto text-[10px] text-muted-foreground">{item.count}</span>
											</Sidebar.MenuSubButton>
										</Sidebar.MenuSubItem>
									{/each}
									<Sidebar.MenuSubItem>
										<Sidebar.MenuSubButton
											href={resolve('/dashboard/health/metrics')}
											isActive={currentPath.startsWith(resolve('/dashboard/health/metrics'))}
										>
											<span>{m.nav_all_metrics()}</span>
										</Sidebar.MenuSubButton>
									</Sidebar.MenuSubItem>
								</Sidebar.MenuSub>
							</Sidebar.MenuItem>
						{/if}
						{#each items.slice(2) as item (item.href)}
							{@render navItem(item)}
						{/each}
					</Sidebar.Menu>
				</Sidebar.GroupContent>
			</Sidebar.Group>
		</Sidebar.Content>
	</Sidebar.Root>
	<Sidebar.Inset>
		<SiteHeader>
			{#snippet leading()}
				<Sidebar.Trigger />
			{/snippet}
		</SiteHeader>
		<main class="flex-1 p-4 md:p-6">
			{@render children()}
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
