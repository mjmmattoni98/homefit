import { isSignupEnabled } from '#lib/server/auth.js';
import { googleHealthConfig } from '#lib/server/config.js';
import { TIME_ZONE_COOKIE } from '#lib/time-zone.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, cookies }) => ({
	user: locals.user ? { name: locals.user.name, email: locals.user.email } : null,
	signupEnabled: await isSignupEnabled(),
	googleHealthEnabled: googleHealthConfig !== null,
	timeZoneKnown: cookies.get(TIME_ZONE_COOKIE) !== undefined
});
