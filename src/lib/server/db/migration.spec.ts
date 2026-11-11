import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it } from 'vitest';

it('upgrades a populated database without discarding historical duplicate workouts', async () => {
	const folder = await mkdtemp(resolve(tmpdir(), 'homefit-migration-'));
	const client = new PGlite();
	try {
		await cp(resolve('drizzle'), folder, { recursive: true });
		const journalPath = resolve(folder, 'meta/_journal.json');
		const journal = JSON.parse(await readFile(journalPath, 'utf8'));
		journal.entries = journal.entries.slice(0, -1);
		await writeFile(journalPath, JSON.stringify(journal));
		const db = drizzle(client);
		await migrate(db, { migrationsFolder: folder });
		await client.exec(`INSERT INTO "user" (id, name, email) VALUES ('synthetic-owner', 'Synthetic', 'synthetic@example.com');
   INSERT INTO workout (user_id, title, start_time, end_time) VALUES
   ('synthetic-owner', 'Original', '2026-01-01T18:00Z', '2026-01-01T19:00Z'),
   ('synthetic-owner', 'Old rename duplicate', '2026-01-01T18:00Z', '2026-01-01T19:00Z');`);
		await migrate(db, { migrationsFolder: resolve('drizzle') });
		expect(
			(await client.query<{ count: number }>('SELECT count(*)::integer AS count FROM workout'))
				.rows[0].count
		).toBe(2);
		await client.exec(
			`INSERT INTO csv_settings (user_id, time_zone) VALUES ('synthetic-owner', 'Europe/Madrid')`
		);
		expect((await client.query('SELECT * FROM signup_gate')).rows).toEqual([]);
	} finally {
		await client.close();
		await rm(folder, { recursive: true, force: true });
	}
});
