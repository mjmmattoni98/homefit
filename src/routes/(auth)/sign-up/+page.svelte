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
	import InfoIcon from '@lucide/svelte/icons/info';

	let { form } = $props();

	let submitting = $state(false);
</script>

<svelte:head>
	<title>{m.sign_up()} · {m.app_name()}</title>
</svelte:head>

<Card.Root>
	<Card.Header>
		<Card.Title>{m.auth_sign_up_title()}</Card.Title>
		<Card.Description>{m.auth_sign_up_description()}</Card.Description>
	</Card.Header>
	<Card.Content>
		{#if !page.data.signupEnabled}
			<Alert.Root>
				<InfoIcon aria-hidden="true" />
				<Alert.Title>{m.auth_signup_disabled_title()}</Alert.Title>
				<Alert.Description>{m.auth_signup_disabled_description()}</Alert.Description>
			</Alert.Root>
		{:else}
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
						<Field.Label for="name">{m.auth_name()}</Field.Label>
						<Input
							id="name"
							name="name"
							autocomplete="name"
							required
							maxlength={200}
							value={form?.name ?? ''}
						/>
					</Field.Field>
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
							autocomplete="new-password"
							required
							minlength={8}
							aria-describedby="password-hint"
						/>
						<Field.Description id="password-hint">{m.auth_password_hint()}</Field.Description>
					</Field.Field>
					<Button type="submit" disabled={submitting} class="w-full">
						{#if submitting}<Spinner data-icon="inline-start" />{/if}
						{m.sign_up()}
					</Button>
				</Field.Group>
			</form>
		{/if}
	</Card.Content>
	<Card.Footer class="justify-center gap-1 text-sm text-muted-foreground">
		{m.auth_have_account()}
		<a
			href={resolve('sign-in')}
			class="font-medium text-foreground underline-offset-4 hover:underline"
		>
			{m.sign_in()}
		</a>
	</Card.Footer>
</Card.Root>
