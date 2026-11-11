import { expect, it } from 'vitest';
import { importTimeZone, setImportTimeZone } from './csv-settings';
import { createTestDatabase, createUser } from './testing/database';
import { parseHevyCsv } from '../csv/hevy';
import { importWorkouts } from './workouts';

it('persists the first browser zone and deduplicates later imports from another browser zone', async () => {
	const database = await createTestDatabase();
	try {
		const owner = await createUser(database.db);
		const other = await createUser(database.db);
		const first = await importTimeZone(database.db, owner, 'Europe/Madrid');
		const second = await importTimeZone(database.db, owner, 'America/New_York');
		expect(second).toBe(first);
		expect(await importTimeZone(database.db, other, 'Asia/Tokyo')).toBe('Asia/Tokyo');
		const csv =
			'title,start_time,end_time,exercise_title,set_index,reps\nSynthetic,"10 nov 2026, 18:00","10 nov 2026, 19:00",Synthetic Bench,0,8';
		await importWorkouts(database.db, owner, parseHevyCsv(csv, first));
		expect(await importWorkouts(database.db, owner, parseHevyCsv(csv, second))).toMatchObject({
			imported: 0,
			updated: 0,
			skipped: 1
		});
		await setImportTimeZone(database.db, owner, 'UTC');
		expect(await importTimeZone(database.db, owner, 'Asia/Tokyo')).toBe('UTC');
	} finally {
		await database.close();
	}
});

it('refuses a stale parsed batch after a zone change', async () => {
	const { withImportTimeZone } = await import('./csv-settings');
	const database = await createTestDatabase();
	try {
		const owner = await createUser(database.db);
		await importTimeZone(database.db, owner, 'Europe/Madrid');
		await setImportTimeZone(database.db, owner, 'Asia/Tokyo');
		await expect(
			withImportTimeZone(database.db, owner, 'Europe/Madrid', async () => 'written')
		).rejects.toThrow('changed');
		expect(await withImportTimeZone(database.db, owner, 'Asia/Tokyo', async () => 'written')).toBe(
			'written'
		);
	} finally {
		await database.close();
	}
});
