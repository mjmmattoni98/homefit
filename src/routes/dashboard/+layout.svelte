<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { api } from '$convex/_generated/api';
	import { useAuth, useQuery } from 'convex-svelte';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as m from '$lib/paraglide/messages';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import { categoryLabel } from '$lib/google-health/labels';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import HeartPulseIcon from '@lucide/svelte/icons/heart-pulse';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import type { Component } from 'svelte';

	let { children } = $props();

	const items: { href: string; label: () => string; icon: Component }[] = [
		{ href: '/dashboard', label: () => m.nav_overview(), icon: LayoutDashboardIcon },
		{ href: '/dashboard/exercises', label: () => m.nav_exercises(), icon: DumbbellIcon },
		{ href: '/dashboard/import', label: () => m.nav_import(), icon: UploadIcon }
	];

	const auth = useAuth();
	const categoriesQuery = useQuery(api.googleHealth.records.listCategories, () =>
		auth.isAuthenticated ? {} : 'skip'
	);
	const categories = $derived(categoriesQuery.data ?? []);
	const currentPath = $derived(page.url.pathname);
</script>

<Sidebar.Provider>
	<Sidebar.Root collapsible="icon">
		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupLabel>{m.app_name()}</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each items.slice(0, 2) as item (item.href)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={currentPath === item.href}>
									{#snippet child({ props })}
										<a href={resolve(item.href as Pathname)} {...props}>
											<item.icon />
											<span>{item.label()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
						{/each}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={currentPath.startsWith('/dashboard/health')}>
								{#snippet child({ props })}
									<a href={resolve('/dashboard/health' as Pathname)} {...props}>
										<HeartPulseIcon />
										<span>{m.nav_health()}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
							<Sidebar.MenuSub>
								{#each categories as item (item.category)}
									{@const href = `/dashboard/health/${item.category}`}
									<Sidebar.MenuSubItem>
										<Sidebar.MenuSubButton
											href={resolve(href as Pathname)}
											isActive={currentPath === href}
										>
											<span>{categoryLabel(item.category)}</span>
											<span class="ml-auto text-[10px] text-muted-foreground">{item.count}</span>
										</Sidebar.MenuSubButton>
									</Sidebar.MenuSubItem>
								{/each}
								<Sidebar.MenuSubItem>
									<Sidebar.MenuSubButton
										href={resolve('/dashboard/health/metrics' as Pathname)}
										isActive={currentPath.startsWith('/dashboard/health/metrics')}
									>
										<span>{m.nav_all_metrics()}</span>
									</Sidebar.MenuSubButton>
								</Sidebar.MenuSubItem>
							</Sidebar.MenuSub>
						</Sidebar.MenuItem>
						{#each items.slice(2) as item (item.href)}
							<Sidebar.MenuItem>
								<Sidebar.MenuButton isActive={currentPath === item.href}>
									{#snippet child({ props })}
										<a href={resolve(item.href as Pathname)} {...props}>
											<item.icon />
											<span>{item.label()}</span>
										</a>
									{/snippet}
								</Sidebar.MenuButton>
							</Sidebar.MenuItem>
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
			<AuthGate>
				{@render children()}
			</AuthGate>
		</main>
	</Sidebar.Inset>
</Sidebar.Provider>
