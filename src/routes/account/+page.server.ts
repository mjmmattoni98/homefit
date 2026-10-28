import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { MIN_PASSWORD_LENGTH } from '#lib/server/auth-config.js';
import { auth } from '#lib/server/auth.js';
import { credentialAttempts } from '#lib/server/rate-limit.js';
import * as m from '#lib/paraglide/messages.js';
import type { Actions, PageServerLoad } from './$types';

function errorCode(error: unknown): string {
	return error instanceof APIError ? String(error.body?.code ?? '') : '';
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (!locals.user) redirect(303, `/sign-in?redirectTo=${encodeURIComponent(url.pathname)}`);
	return {};
};

export const actions: Actions = {
	updateProfile: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		if (name === '' || name.length > 200) {
			return fail(400, { action: 'profile' as const, message: m.auth_error_required() });
		}
		await auth.api.updateUser({ body: { name }, headers: request.headers });
		return { action: 'profile' as const, success: true };
	},
	changePassword: async ({ request, locals }) => {
		const form = await request.formData();
		const currentPassword = String(form.get('currentPassword') ?? '');
		const newPassword = String(form.get('newPassword') ?? '');
		if (newPassword.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { action: 'password' as const, message: m.auth_error_password_length() });
		}
		if (!credentialAttempts.consume(`user:${locals.user?.id}`)) {
			return fail(429, { action: 'password' as const, message: m.auth_error_rate_limited() });
		}
		try {
			await auth.api.changePassword({
				body: { currentPassword, newPassword, revokeOtherSessions: true },
				headers: request.headers
			});
		} catch (error) {
			if (errorCode(error) === 'INVALID_PASSWORD') {
				return fail(400, {
					action: 'password' as const,
					message: m.account_error_wrong_password()
				});
			}
			console.error('[auth] password change failed', error);
			return fail(500, { action: 'password' as const, message: m.auth_error_generic() });
		}
		return { action: 'password' as const, success: true };
	},
	deleteAccount: async ({ request, locals }) => {
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		if (password === '') {
			return fail(400, { action: 'delete' as const, message: m.auth_error_required() });
		}
		if (!credentialAttempts.consume(`user:${locals.user?.id}`)) {
			return fail(429, { action: 'delete' as const, message: m.auth_error_rate_limited() });
		}
		try {
			await auth.api.deleteUser({ body: { password }, headers: request.headers });
		} catch (error) {
			if (errorCode(error) === 'INVALID_PASSWORD') {
				return fail(400, { action: 'delete' as const, message: m.account_error_wrong_password() });
			}
			console.error('[auth] account deletion failed', error);
			return fail(500, { action: 'delete' as const, message: m.auth_error_generic() });
		}
		redirect(303, '/');
	}
};
