/** Database name reserved for the disposable Compose project in `compose.test.yaml`. */
export const TEST_DATABASE_NAME = 'homefit_test';

const INSTANCES = ['main', 'test'] as const;

export type HomefitInstance = (typeof INSTANCES)[number];

export interface InstanceBoundary {
	instance: string;
	database: string;
	googleHealthClientId?: string | undefined;
	googleHealthClientSecret?: string | undefined;
	googleHealthEncryptionKey?: string | undefined;
}

/**
 * Refuses to boot when the test stack could reach the main database or Google Health
 * credentials, and when the main stack is pointed at the disposable database.
 */
export function assertInstanceBoundary(input: InstanceBoundary): void {
	if (!INSTANCES.includes(input.instance as HomefitInstance)) {
		throw new Error('HOMEFIT_INSTANCE must be "main" or "test".');
	}
	const instance = input.instance as HomefitInstance;
	const database = input.database.trim();

	if (instance === 'test' && database !== TEST_DATABASE_NAME) {
		throw new Error(`HOMEFIT_INSTANCE=test only starts when POSTGRES_DB is ${TEST_DATABASE_NAME}.`);
	}
	if (instance === 'main' && database === TEST_DATABASE_NAME) {
		throw new Error(
			`POSTGRES_DB=${TEST_DATABASE_NAME} belongs to the disposable test stack. Set HOMEFIT_INSTANCE=test to use it.`
		);
	}
	if (instance !== 'test') return;

	const present = (
		[
			['GOOGLE_HEALTH_CLIENT_ID', input.googleHealthClientId],
			['GOOGLE_HEALTH_CLIENT_SECRET', input.googleHealthClientSecret],
			['GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY', input.googleHealthEncryptionKey]
		] as const
	).filter(([, value]) => (value ?? '').trim() !== '');
	if (present.length > 0) {
		throw new Error(
			`The test stack starts with Google Health disabled. Unset ${present.map(([name]) => name).join(', ')}.`
		);
	}
}
