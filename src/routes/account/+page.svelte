<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { page } from '$app/state';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import * as m from '#lib/paraglide/messages.js';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import CheckIcon from '@lucide/svelte/icons/check';

	let { form } = $props();

	let pending = $state<string | null>(null);
	let deleteOpen = $state(false);

	const user = $derived(page.data.user);

	const confirmDeletion: SubmitFunction = (input) => {
		if (input.formData.get('confirmation') !== 'delete-account') {
			input.cancel();
			deleteOpen = true;
			return;
		}
		return track('delete')(input);
	};

	function track(action: string): SubmitFunction {
		return () => {
			pending = action;
			return async ({ update }) => {
				await update();
				pending = null;
				deleteOpen = false;
			};
		};
	}
</script>

<svelte:head>
	<title>{m.account_title()} · {m.app_name()}</title>
</svelte:head>

{#snippet feedback(action: string)}
	{#if form?.action === action && 'message' in form}
		<Alert.Root variant="destructive">
			<AlertCircleIcon aria-hidden="true" />
			<Alert.Description>{form.message}</Alert.Description>
		</Alert.Root>
	{:else if form?.action === action && 'success' in form}
		<p class="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400" role="status">
			<CheckIcon class="size-4" aria-hidden="true" />
			{action === 'profile' ? m.account_profile_saved() : m.account_password_changed()}
		</p>
	{/if}
{/snippet}

<SiteHeader />

<main class="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">{m.account_title()}</h1>
		<p class="text-sm text-muted-foreground">{m.account_description()}</p>
	</div>

	<Card.Root>
		<Card.Header>
			<Card.Title>{m.account_profile_title()}</Card.Title>
			<Card.Description>{m.account_profile_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/updateProfile" use:enhance={track('profile')}>
				<Field.Group>
					{@render feedback('profile')}
					<Field.Field>
						<Field.Label for="name">{m.auth_name()}</Field.Label>
						<Input
							id="name"
							name="name"
							autocomplete="name"
							required
							maxlength={200}
							value={user?.name ?? ''}
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="email">{m.auth_email()}</Field.Label>
						<Input id="email" type="email" value={user?.email ?? ''} disabled />
					</Field.Field>
					<Button type="submit" class="w-fit" disabled={pending !== null}>{m.account_save()}</Button
					>
				</Field.Group>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>{m.account_password_title()}</Card.Title>
			<Card.Description>{m.account_password_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			<form method="POST" action="?/changePassword" use:enhance={track('password')}>
				<Field.Group>
					{@render feedback('password')}
					<Field.Field>
						<Field.Label for="current-password">{m.account_current_password()}</Field.Label>
						<Input
							id="current-password"
							name="currentPassword"
							type="password"
							autocomplete="current-password"
							required
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="new-password">{m.account_new_password()}</Field.Label>
						<Input
							id="new-password"
							name="newPassword"
							type="password"
							autocomplete="new-password"
							minlength={8}
							required
						/>
						<Field.Description>{m.auth_password_hint()}</Field.Description>
					</Field.Field>
					<Button type="submit" class="w-fit" disabled={pending !== null}>
						{m.account_change_password()}
					</Button>
				</Field.Group>
			</form>
		</Card.Content>
	</Card.Root>

	<Card.Root class="border-destructive/40">
		<Card.Header>
			<Card.Title>{m.account_delete_title()}</Card.Title>
			<Card.Description>{m.account_delete_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			<form
				id="delete-account-form"
				method="POST"
				action="?/deleteAccount"
				use:enhance={confirmDeletion}
			>
				<Field.Group>
					{@render feedback('delete')}
					<Field.Field>
						<Field.Label for="delete-password">{m.account_delete_password()}</Field.Label>
						<Input
							id="delete-password"
							name="password"
							type="password"
							autocomplete="current-password"
							required
						/>
					</Field.Field>
					<Button type="submit" variant="destructive" class="w-fit" disabled={pending !== null}>
						{m.account_delete_button()}
					</Button>
				</Field.Group>
			</form>
		</Card.Content>
	</Card.Root>
</main>

<AlertDialog.Root bind:open={deleteOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.account_delete_dialog_title()}</AlertDialog.Title>
			<AlertDialog.Description>{m.account_delete_dialog_description()}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={pending !== null}>{m.cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action
				type="submit"
				form="delete-account-form"
				name="confirmation"
				value="delete-account"
				variant="destructive"
				disabled={pending !== null}
			>
				{m.account_delete_button()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
