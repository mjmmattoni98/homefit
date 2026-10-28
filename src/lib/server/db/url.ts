const DEFAULT_USER = 'homefit';
const DEFAULT_DATABASE = 'homefit';
const DEFAULT_HOST = 'localhost';
const DEFAULT_PORT = '5432';

export interface PostgresConnectionParts {
	user?: string | undefined;
	password?: string | undefined;
	database?: string | undefined;
	host?: string | undefined;
	port?: string | number | undefined;
}

/** Connection string for `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. */
export function postgresConnectionString(parts: PostgresConnectionParts): string {
	const user = orDefault(parts.user, DEFAULT_USER);
	const database = orDefault(parts.database, DEFAULT_DATABASE);
	const host = orDefault(parts.host, DEFAULT_HOST);
	const port = orDefault(parts.port === undefined ? undefined : String(parts.port), DEFAULT_PORT);
	if (!/^[A-Za-z0-9._-]+$/.test(host)) {
		throw new Error('POSTGRES_HOST must be a hostname');
	}
	const portNumber = Number(port);
	if (
		!/^\d+$/.test(port) ||
		!Number.isInteger(portNumber) ||
		portNumber < 1 ||
		portNumber > 65535
	) {
		throw new Error('POSTGRES_PORT must be an integer from 1 to 65535');
	}
	const password = parts.password?.trim() ?? '';
	return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}`;
}

function orDefault(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim() ?? '';
	return trimmed === '' ? fallback : trimmed;
}
