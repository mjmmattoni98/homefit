/** Returns `value` when it is a same-origin absolute path, otherwise `fallback`. */
export function safeRedirectPath(
	value: string | null | undefined,
	fallback = '/dashboard'
): string {
	if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//'))
		return fallback;
	if (value.includes('\\') || [...value].some((character) => character.charCodeAt(0) < 32)) {
		return fallback;
	}
	return value;
}
