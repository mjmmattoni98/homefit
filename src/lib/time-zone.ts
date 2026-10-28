/**
 * Cookie through which the browser tells the server its time zone, so dashboard days split at
 * the user's local midnight even when the page is rendered on the server.
 */
export const TIME_ZONE_COOKIE = 'tz';

/** The browser's IANA time zone, e.g. `Europe/Madrid`. */
export function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Stores `timeZone` in the cookie read by the server. */
export function rememberTimeZone(timeZone: string): void {
	document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=31536000; samesite=lax`;
}
