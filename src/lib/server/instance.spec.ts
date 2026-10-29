import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertInstanceBoundary, TEST_DATABASE_NAME } from './instance';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('assertInstanceBoundary', () => {
	it('allows the main app to use its own database', () => {
		expect(() =>
			assertInstanceBoundary({
				instance: 'main',
				database: 'homefit',
				googleHealthClientId: 'client'
			})
		).not.toThrow();
	});

	it('allows the test app only on the disposable database without Google Health credentials', () => {
		expect(() =>
			assertInstanceBoundary({
				instance: 'test',
				database: TEST_DATABASE_NAME,
				googleHealthClientId: ' ',
				googleHealthClientSecret: '',
				googleHealthEncryptionKey: undefined
			})
		).not.toThrow();
	});

	it('stops the test app from opening any other database', () => {
		expect(() => assertInstanceBoundary({ instance: 'test', database: 'homefit' })).toThrow(
			/homefit_test/
		);
		expect(() => assertInstanceBoundary({ instance: 'test', database: 'postgres' })).toThrow(
			/POSTGRES_DB/
		);
	});

	it('stops the main app from opening the disposable database', () => {
		expect(() =>
			assertInstanceBoundary({ instance: 'main', database: TEST_DATABASE_NAME })
		).toThrow(/disposable test stack/);
	});

	it('stops the test app from loading Google Health credentials', () => {
		expect(() =>
			assertInstanceBoundary({
				instance: 'test',
				database: TEST_DATABASE_NAME,
				googleHealthClientId: 'client-id'
			})
		).toThrow(/GOOGLE_HEALTH_CLIENT_ID/);
	});

	it('rejects an unknown instance name', () => {
		expect(() => assertInstanceBoundary({ instance: 'production', database: 'homefit' })).toThrow(
			/HOMEFIT_INSTANCE/
		);
	});
});

describe('Compose isolation', () => {
	const main = readFileSync(join(root, 'compose.yaml'), 'utf8');
	const dev = readFileSync(join(root, 'compose.dev.yaml'), 'utf8');
	const test = readFileSync(join(root, 'compose.test.yaml'), 'utf8');
	const testConfig = test
		.split('\n')
		.filter((line) => !line.trim().startsWith('#'))
		.join('\n');

	it('keeps the main database off the host port and publishes it only from the dev override', () => {
		expect(main).not.toContain('127.0.0.1:${POSTGRES_PORT:-5432}:5432');
		expect(dev).toContain('127.0.0.1:${POSTGRES_PORT:-5432}:5432');
	});

	it('pins the test stack to literals, its own volume, and port 3300', () => {
		expect(testConfig).not.toContain('${');
		expect(testConfig).not.toContain('env_file');
		expect(testConfig).toContain('POSTGRES_DB: homefit_test');
		expect(testConfig).toContain('name: homefit-test-pgdata');
		expect(testConfig).toContain('127.0.0.1:3300:3000');
		expect(testConfig).toContain('127.0.0.1:5434:5432');
	});
});
