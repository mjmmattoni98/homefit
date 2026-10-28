import { pool } from '#lib/server/db/index.js';
import type { RequestHandler } from './$types';

/** Liveness and database readiness probe used by container health checks. */
export const GET: RequestHandler = async () => {
	try {
		await pool.query('select 1');
		return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
	} catch {
		return Response.json({ status: 'unavailable' }, { status: 503 });
	}
};
