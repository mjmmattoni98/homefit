import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';

/** Returns the signed-in user's ID inside a remote function, or responds with 401. */
export function requireUserId(): string {
	const { locals } = getRequestEvent();
	if (locals.user === undefined) error(401, 'Not authenticated');
	return locals.user.id;
}
