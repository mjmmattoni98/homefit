<script lang="ts">
	import type { Pathname } from '$app/types';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as m from '$lib/paraglide/messages';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import SiteHeader from '$lib/components/SiteHeader.svelte';
	import LayoutDashboardIcon from '@lucide/svelte/icons/layout-dashboard';
	import DumbbellIcon from '@lucide/svelte/icons/dumbbell';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import type { Component } from 'svelte';

	let { children } = $props();

	const items: { href: string; label: () => string; icon: Component }[] = [
		{ href: '/dashboard', label: () => m.nav_overview(), icon: LayoutDashboardIcon },
		{ href: '/dashboard/exercises', label: () => m.nav_exercises(), icon: DumbbellIcon },
		{ href: '/dashboard/import', label: () => m.nav_import(), icon: UploadIcon }
	];

	const currentPath = $derived(page.url.pathname);
</script>

<Sidebar.Provider>
	<Sidebar.Root collapsible="icon">
		<Sidebar.Content>
			<Sidebar.Group>
				<Sidebar.GroupLabel>{m.app_name()}</Sidebar.GroupLabel>
				<Sidebar.GroupContent>
					<Sidebar.Menu>
						{#each items as item (item.href)}
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
