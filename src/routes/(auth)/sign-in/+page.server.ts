import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import { auth } from '#lib/server/auth.js';
import { consumeSignInAttempt, credentialAttempts } from '#lib/server/rate-limit.js';
import { safeRedirectPath } from '#lib/server/redirect.js';
import * as m from '#lib/paraglide/messages.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const redirectTo = safeRedirectPath(url.searchParams.get('redirectTo'));
	if (locals.user) redirect(303, redirectTo);
	return { redirectTo };
};

export const actions: Actions = {
	default: async ({ request, url, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		if (email === '' || password === '') {
			return fail(400, { email, message: m.auth_error_required() });
		}
		if (!consumeSignInAttempt(credentialAttempts, getClientAddress(), email)) {
			return fail(429, { email, message: m.auth_error_rate_limited() });
		}
		try {
			await auth.api.signInEmail({ body: { email, password }, headers: request.headers });
		} catch (error) {
			const code = error instanceof APIError ? String(error.body?.code ?? '') : '';
			if (code === 'INVALID_EMAIL_OR_PASSWORD' || code === 'INVALID_EMAIL') {
				return fail(400, { email, message: m.auth_error_invalid_credentials() });
			}
			console.error('[auth] sign-in failed', error);
			return fail(500, { email, message: m.auth_error_generic() });
		}
		redirect(303, safeRedirectPath(url.searchParams.get('redirectTo')));
	}
};
