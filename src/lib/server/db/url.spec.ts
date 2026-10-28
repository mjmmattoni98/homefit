import { describe, expect, it } from 'vitest';
import { postgresConnectionString } from './url';

describe('postgresConnectionString', () => {
	it('builds a URL from the database user, password, and name', () => {
		expect(
			postgresConnectionString({
				user: 'homefit',
				password: 'secret',
				database: 'homefit'
			})
		).toBe('postgres://homefit:secret@localhost:5432/homefit');
	});

	it('fills in the same defaults Docker Compose uses when user, database, host, or port are blank', () => {
		expect(postgresConnectionString({ password: 'secret' })).toBe(
			'postgres://homefit:secret@localhost:5432/homefit'
		);
		expect(
			postgresConnectionString({
				user: ' ',
				password: 'secret',
				database: '',
				host: '',
				port: ''
			})
		).toBe('postgres://homefit:secret@localhost:5432/homefit');
	});

	it('percent-encodes credentials so they only need to be written once', () => {
		expect(
			postgresConnectionString({
				user: 'home fit',
				password: 'p@ss:word',
				database: 'home/fit',
				host: 'db',
				port: 5433
			})
		).toBe('postgres://home%20fit:p%40ss%3Aword@db:5433/home%2Ffit');
	});

	it('rejects a host or port that cannot go in the connection string', () => {
		expect(() => postgresConnectionString({ password: 'secret', host: 'db:5432' })).toThrow(
			/POSTGRES_HOST/
		);
		expect(() => postgresConnectionString({ password: 'secret', port: '0' })).toThrow(
			/POSTGRES_PORT/
		);
		expect(() => postgresConnectionString({ password: 'secret', port: 'eighty' })).toThrow(
			/POSTGRES_PORT/
		);
	});
});
