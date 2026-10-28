import { DISABLE_SIGNUP } from '$app/env/private';
import { googleHealthConfig } from '#lib/server/config.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
	user: locals.user ? { name: locals.user.name, email: locals.user.email } : null,
	signupEnabled: !DISABLE_SIGNUP,
	googleHealthEnabled: googleHealthConfig !== null
});
