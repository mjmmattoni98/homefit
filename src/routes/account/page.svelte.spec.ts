import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { SubmitFunction } from '$app/forms';
import AccountPage from './+page.svelte';

const mocks = vi.hoisted(() => ({ submissions: vi.fn() }));

vi.mock('$app/state', () => ({
	page: { data: { user: { name: 'QA', email: 'qa@example.invalid' } } }
}));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

// Use SvelteKit's real enhancement and native form submission; replace the response update
// because this component test has no application router or authentication server.
vi.mock('$app/forms', async (importOriginal) => {
	const original = await importOriginal<typeof import('$app/forms')>();
	return {
		...original,
		enhance: (element: HTMLFormElement, submit: SubmitFunction) =>
			original.enhance(element, (input) => {
				const callback = submit(input);
				return async (result) => {
					mocks.submissions(Object.fromEntries(input.formData));
					const handler = await callback;
					if (handler) await handler({ ...result, update: async () => {} });
				};
			})
	};
});

describe('account deletion confirmation', () => {
	beforeEach(() => {
		mocks.submissions.mockClear();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ type: 'failure', status: 400 }))
		);
	});

	it('Enter opens confirmation and Cancel prevents deletion', async () => {
		render(AccountPage, { form: null });
		const password = page.getByLabelText('Confirm with your password');
		await password.fill('Disposable-test-password');
		await password.click();
		await userEvent.keyboard('{Enter}');
		await expect.element(page.getByRole('alertdialog')).toBeInTheDocument();
		expect(fetch).not.toHaveBeenCalled();
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
		expect(mocks.submissions).not.toHaveBeenCalled();
	});

	it('only the confirmation button submits the password and confirmation', async () => {
		render(AccountPage, { form: null });
		await page.getByLabelText('Confirm with your password').fill('Disposable-test-password');
		await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
		expect(fetch).not.toHaveBeenCalled();
		await page.getByRole('alertdialog').getByRole('button', { name: 'Delete my account' }).click();
		await expect.poll(() => mocks.submissions.mock.calls.length).toBe(1);
		expect(mocks.submissions).toHaveBeenCalledWith({
			password: 'Disposable-test-password',
			confirmation: 'delete-account'
		});
	});
});
