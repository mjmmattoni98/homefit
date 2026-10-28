<script lang="ts">
	import { resolve } from '$app/paths';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import LogOutIcon from '@lucide/svelte/icons/log-out';
	import UserIcon from '@lucide/svelte/icons/user';

	let { user }: { user: { name: string; email: string } } = $props();

	const initials = $derived(
		user.name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('') || user.email[0]?.toUpperCase()
	);
</script>

<form id="sign-out-form" method="POST" action={resolve('/sign-out')} hidden></form>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon' })}
		aria-label={m.nav_account()}
	>
		<Avatar.Root class="size-7">
			<Avatar.Fallback class="text-xs">{initials}</Avatar.Fallback>
		</Avatar.Root>
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="w-56">
		<DropdownMenu.Label class="flex flex-col">
			<span class="truncate text-sm font-medium">{user.name}</span>
			<span class="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
		</DropdownMenu.Label>
		<DropdownMenu.Separator />
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a href={resolve('/account')} {...props}>
					<UserIcon />
					{m.nav_account()}
				</a>
			{/snippet}
		</DropdownMenu.Item>
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<button type="submit" form="sign-out-form" {...props}>
					<LogOutIcon />
					{m.sign_out()}
				</button>
			{/snippet}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
