import { describe, expect, it } from 'vitest';
import { variables } from './env';

type EnvSchema = {
	'~standard': {
		validate: (
			value: unknown
		) => Promise<{ value?: unknown; issues?: readonly { message: string }[] }>;
	};
};

async function read(schema: EnvSchema, value: string | undefined): Promise<unknown> {
	const result = await schema['~standard'].validate(value);
	if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('\n'));
	return result.value;
}

describe('PostgreSQL environment variables', () => {
	it('defaults the user, database, host, and port when they are unset', async () => {
		const user = variables.POSTGRES_USER.schema as EnvSchema;
		const database = variables.POSTGRES_DB.schema as EnvSchema;
		const host = variables.POSTGRES_HOST.schema as EnvSchema;
		const port = variables.POSTGRES_PORT.schema as EnvSchema;
		expect(
			await Promise.all([
				read(user, undefined),
				read(database, ' '),
				read(host, ''),
				read(port, undefined)
			])
		).toEqual(['homefit', 'homefit', 'localhost', '5432']);
	});

	it('rejects a host or port that cannot be placed in the connection string', async () => {
		const host = variables.POSTGRES_HOST.schema as EnvSchema;
		const port = variables.POSTGRES_PORT.schema as EnvSchema;
		await expect(read(host, 'db:5432')).rejects.toThrow(/POSTGRES_HOST/);
		await expect(read(port, '0')).rejects.toThrow(/POSTGRES_PORT/);
		await expect(read(port, '65536')).rejects.toThrow(/POSTGRES_PORT/);
	});
});
