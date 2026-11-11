import { error, fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { MIN_PASSWORD_LENGTH } from '#lib/server/auth-config.js';
import { isSignupEnabled, registerUser } from '#lib/server/auth.js';
import { credentialAttempts } from '#lib/server/rate-limit.js';
import { SignupClosedError } from '#lib/server/signup.js';
import * as m from '#lib/paraglide/messages.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) redirect(303, '/dashboard');
	return {};
};

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		if (!(await isSignupEnabled())) error(403, 'Sign-ups are disabled');
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (name === '' || email === '' || password === '') {
			return fail(400, { name, email, message: m.auth_error_required() });
		}
		if (password.length < MIN_PASSWORD_LENGTH) {
			return fail(400, { name, email, message: m.auth_error_password_length() });
		}
		if (!credentialAttempts.consume(`ip:${getClientAddress()}`)) {
			return fail(429, { name, email, message: m.auth_error_rate_limited() });
		}
		try {
			await registerUser({ body: { name, email, password }, headers: request.headers });
		} catch (failure) {
			// Another first registration won the race after the check above.
			if (failure instanceof SignupClosedError) error(403, 'Sign-ups are disabled');
			const code = failure instanceof APIError ? String(failure.body?.code ?? '') : '';
			const message = code.startsWith('USER_ALREADY_EXISTS')
				? m.auth_error_email_taken()
				: code === 'PASSWORD_TOO_SHORT'
					? m.auth_error_password_length()
					: code === 'INVALID_EMAIL'
						? m.auth_error_invalid_email()
						: null;
			if (message !== null) return fail(400, { name, email, message });
			console.error('[auth] sign-up failed', failure);
			return fail(500, { name, email, message: m.auth_error_generic() });
		}
		redirect(303, '/dashboard');
	}
};
