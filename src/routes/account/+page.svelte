<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { page } from '$app/state';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
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
	<title>{m.account_title()}: {m.app_name()}</title>
</svelte:head>

{#snippet feedback(action: string)}
	{#if form?.action === action && 'message' in form}
		<p class="flex items-start gap-1.5 text-sm text-error" role="alert">
			<AlertCircleIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{form.message}
		</p>
	{:else if form?.action === action && 'success' in form}
		<p class="flex items-start gap-1.5 text-sm font-medium text-success" role="status">
			<CheckIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
			{action === 'profile' ? m.account_profile_saved() : m.account_password_changed()}
		</p>
	{/if}
{/snippet}

<SiteHeader />

<!-- Outside the dashboard there is no page grid, so the page keeps its own capped column. The
     person stands on the left, set like the overview's lead figures; what can be changed is
     stacked on the right, each part opened by the heavy rule that opens a ledger. -->
<main class="mx-auto w-full max-w-(--container) px-4 pb-20 md:px-8">
	<div class="border-b border-rule pt-7 pb-3">
		<h1 class="text-4xl">{m.account_title()}</h1>
		<p class="mt-1.5 text-sm text-ink-3">{m.account_description()}</p>
	</div>

	<div
		class="mt-10 grid items-start gap-x-14 gap-y-12 lg:mt-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]"
	>
		{#if user}
			<div class="min-w-0 lg:sticky lg:top-24">
				<p class="text-4xl font-figure wrap-break-word sm:text-5xl">{user.name}</p>
				<p class="mt-2 text-sm wrap-break-word text-ink-3">{user.email}</p>
			</div>
		{/if}

		<div class="flex min-w-0 flex-col gap-16 lg:col-start-2">
			<section class="border-t border-ink pt-5" aria-labelledby="account-profile-title">
				<h2 id="account-profile-title" class="text-2xl">{m.account_profile_title()}</h2>
				<p class="mt-2 text-sm text-ink-3">{m.account_profile_description()}</p>
				<form method="POST" action="?/updateProfile" class="mt-7" use:enhance={track('profile')}>
					<Field.Group>
						<div class="grid gap-x-6 gap-y-4 sm:grid-cols-2">
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
						</div>
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
							<Button type="submit" class="w-fit" disabled={pending !== null}>
								{m.account_save()}
							</Button>
							{@render feedback('profile')}
						</div>
					</Field.Group>
				</form>
			</section>

			<section class="border-t border-ink pt-5" aria-labelledby="account-password-title">
				<h2 id="account-password-title" class="text-2xl">{m.account_password_title()}</h2>
				<p class="mt-2 text-sm text-ink-3">{m.account_password_description()}</p>
				<form method="POST" action="?/changePassword" class="mt-7" use:enhance={track('password')}>
					<Field.Group>
						<div class="grid items-start gap-x-6 gap-y-4 sm:grid-cols-2">
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
						</div>
						<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
							<Button type="submit" variant="outline" class="w-fit" disabled={pending !== null}>
								{m.account_change_password()}
							</Button>
							{@render feedback('password')}
						</div>
					</Field.Group>
				</form>
			</section>

			<!-- Quieter than the rest: a hairline instead of the heavy rule, and nothing happens
			     without the confirmation dialog. -->
			<section class="border-t border-rule pt-5" aria-labelledby="account-delete-title">
				<h2 id="account-delete-title" class="text-xl">{m.account_delete_title()}</h2>
				<p class="mt-2 max-w-[60ch] text-sm text-ink-3">{m.account_delete_description()}</p>
				<form
					id="delete-account-form"
					method="POST"
					action="?/deleteAccount"
					class="mt-6"
					use:enhance={confirmDeletion}
				>
					<Field.Group>
						<div class="grid items-end gap-x-6 gap-y-4 sm:grid-cols-2">
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
						</div>
						{@render feedback('delete')}
					</Field.Group>
				</form>
			</section>
		</div>
	</div>
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
