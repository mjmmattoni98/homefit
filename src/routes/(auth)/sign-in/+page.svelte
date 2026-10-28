<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as m from '#lib/paraglide/messages.js';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';

	let { form } = $props();

	let submitting = $state(false);
</script>

<svelte:head>
	<title>{m.sign_in()} · {m.app_name()}</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>{m.auth_sign_in_title()}</Card.Title>
		<Card.Description>{m.auth_sign_in_description()}</Card.Description>
	</Card.Header>
	<Card.Content>
		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
		>
			<Field.Group>
				{#if form?.message}
					<Alert.Root variant="destructive">
						<AlertCircleIcon aria-hidden="true" />
						<Alert.Description>{form.message}</Alert.Description>
					</Alert.Root>
				{/if}
				<Field.Field>
					<Field.Label for="email">{m.auth_email()}</Field.Label>
					<Input
						id="email"
						name="email"
						type="email"
						autocomplete="email"
						required
						value={form?.email ?? ''}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="password">{m.auth_password()}</Field.Label>
					<Input
						id="password"
						name="password"
						type="password"
						autocomplete="current-password"
						required
					/>
				</Field.Field>
				<Button type="submit" disabled={submitting} class="w-full">
					{#if submitting}<Spinner data-icon="inline-start" />{/if}
					{m.sign_in()}
				</Button>
			</Field.Group>
		</form>
	</Card.Content>
	{#if page.data.signupEnabled}
		<Card.Footer class="justify-center gap-1 text-sm text-muted-foreground">
			{m.auth_no_account()}
			<a
				href={resolve('sign-up')}
				class="font-medium text-foreground underline-offset-4 hover:underline"
			>
				{m.sign_up()}
			</a>
		</Card.Footer>
	{/if}
</Card.Root>
