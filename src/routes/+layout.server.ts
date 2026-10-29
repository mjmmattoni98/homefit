import { DISABLE_SIGNUP } from '$app/env/private';
import { googleHealthConfig } from '#lib/server/config.js';
import { TIME_ZONE_COOKIE } from '#lib/time-zone.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, cookies }) => ({
	user: locals.user ? { name: locals.user.name, email: locals.user.email } : null,
	signupEnabled: !DISABLE_SIGNUP,
	googleHealthEnabled: googleHealthConfig !== null,
	timeZoneKnown: cookies.get(TIME_ZONE_COOKIE) !== undefined
});
