import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { env, internalAction, internalMutation, type MutationCtx } from '../_generated/server';
import { canonicalPhysicalCoverageKey } from './normalize';
import { deleteNamedGooglePoint } from './records';
import { getMetricDefinition, type MetricDefinition } from './registry';
import { verifyGoogleHealthSignature } from './webhookSignature';

const PUBLIC_KEYSET_URL =
	'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';
const MAX_RAW_BODY_BYTES = 256 * 1024;
const MAX_AUTHORIZATION_BYTES = 4096;
const MAX_SIGNATURE_LENGTH = 4096;
const MAX_KEYSET_BYTES = 64 * 1024;
const KEYSET_TIMEOUT_MS = 5_000;
const KEYSET_CACHE_MS = 10 * 60 * 1000;
const MAX_BATCH_SIZE = 99;
const MAX_INTERVALS_PER_NOTIFICATION = 16;
const MAX_TOTAL_INTERVALS = 256;
const MAX_SUBSCRIPTION_NAME_LENGTH = 512;
const MAX_RECORD_ID_LENGTH = 1024;
const SYNCABLE_STATUSES = new Set(['backfilling', 'active', 'delayed']);

type PlainObject = Record<string, unknown>;
type NormalizedNotification = {
	healthUserId: string;
	dataType: string;
	operation: 'UPSERT' | 'DELETE';
	windowStart: string;
	windowEnd: string;
	recordId?: string;
};
type ParsedInterval = {
	physical?: { start: string; end: string };
	civil?: { start: string; end: string };
};
type WebhookResult =
	| { kind: 'verification'; accepted: 0 }
	| { kind: 'notification'; accepted: number }
	| { kind: 'unauthorized'; accepted: 0 }
	| { kind: 'invalid'; accepted: 0 };

let cachedKeyset: { value: unknown; expiresAt: number } | null = null;

const normalizedNotificationValidator = v.object({
	healthUserId: v.string(),
	dataType: v.string(),
	operation: v.union(v.literal('UPSERT'), v.literal('DELETE')),
	windowStart: v.string(),
	windowEnd: v.string(),
	recordId: v.optional(v.string())
});

const webhookResultValidator = v.union(
	v.object({ kind: v.literal('verification'), accepted: v.literal(0) }),
	v.object({ kind: v.literal('notification'), accepted: v.number() }),
	v.object({ kind: v.literal('unauthorized'), accepted: v.literal(0) }),
	v.object({ kind: v.literal('invalid'), accepted: v.literal(0) })
);

function isPlainObject(value: unknown): value is PlainObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
	value: PlainObject,
	required: readonly string[],
	optional: readonly string[] = []
): boolean {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => key in value) && keys.every((key) => allowed.has(key));
}

function boundedString(value: unknown, maximumLength: number): string | null {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maximumLength ||
		value.trim() !== value ||
		[...value].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	) {
		return null;
	}
	return value;
}

function constantTimeAuthorizationMatches(received: string | undefined): boolean {
	if (received === undefined) return false;
	const encoder = new TextEncoder();
	const actual = encoder.encode(received);
	const expected = encoder.encode(env.GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION);
	if (
		actual.byteLength === 0 ||
		actual.byteLength > MAX_AUTHORIZATION_BYTES ||
		actual.byteLength !== expected.byteLength
	) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < actual.byteLength; index += 1) {
		difference |= actual[index] ^ expected[index];
	}
	return difference === 0;
}

function isValidDate(year: number, month: number, day: number): boolean {
	if (
		!Number.isInteger(year) ||
		!Number.isInteger(month) ||
		!Number.isInteger(day) ||
		year < 1 ||
		year > 9999
	) {
		return false;
	}
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(year, month - 1, day);
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

function dateString(year: number, month: number, day: number): string {
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseStructuredCivilDateTime(value: unknown): string | null {
	if (!isPlainObject(value) || !hasExactKeys(value, ['date'], ['time'])) return null;
	const date = value.date;
	if (!isPlainObject(date) || !hasExactKeys(date, ['year', 'month', 'day'])) return null;
	if (
		typeof date.year !== 'number' ||
		typeof date.month !== 'number' ||
		typeof date.day !== 'number' ||
		!isValidDate(date.year, date.month, date.day)
	) {
		return null;
	}
	const day = dateString(date.year, date.month, date.day);
	if (value.time === undefined) return day;
	const time = value.time;
	if (!isPlainObject(time) || !hasExactKeys(time, [], ['hours', 'minutes', 'seconds', 'nanos'])) {
		return null;
	}
	const hours = time.hours ?? 0;
	const minutes = time.minutes ?? 0;
	const seconds = time.seconds ?? 0;
	const nanos = time.nanos ?? 0;
	if (
		typeof hours !== 'number' ||
		typeof minutes !== 'number' ||
		typeof seconds !== 'number' ||
		typeof nanos !== 'number' ||
		!Number.isInteger(hours) ||
		!Number.isInteger(minutes) ||
		!Number.isInteger(seconds) ||
		!Number.isInteger(nanos) ||
		hours < 0 ||
		hours > 23 ||
		minutes < 0 ||
		minutes > 59 ||
		seconds < 0 ||
		seconds > 59 ||
		nanos < 0 ||
		nanos > 999_999_999
	) {
		return null;
	}
	return `${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(nanos).padStart(9, '0')}`;
}

function parseCivilIso(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/.exec(
		value
	);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!isValidDate(year, month, day)) return null;
	if (match[4] === undefined) return dateString(year, month, day);
	const hours = Number(match[4]);
	const minutes = Number(match[5]);
	const seconds = Number(match[6] ?? 0);
	if (hours > 23 || minutes > 59 || seconds > 59) return null;
	return `${dateString(year, month, day)}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${(match[7] ?? '').padEnd(9, '0')}`;
}

function parsePhysicalInterval(value: unknown): { start: string; end: string } | null {
	if (!isPlainObject(value) || !hasExactKeys(value, ['startTime', 'endTime'])) return null;
	if (typeof value.startTime !== 'string' || typeof value.endTime !== 'string') return null;
	const start = canonicalPhysicalCoverageKey(value.startTime);
	const end = canonicalPhysicalCoverageKey(value.endTime);
	return start !== undefined && end !== undefined && start < end ? { start, end } : null;
}

function parseCivilInterval(value: unknown): { start: string; end: string } | null {
	if (!isPlainObject(value) || !hasExactKeys(value, ['startTime', 'endTime'])) return null;
	const start = parseCivilIso(value.startTime);
	const end = parseCivilIso(value.endTime);
	return start !== null && end !== null && start < end ? { start, end } : null;
}

function parseStructuredCivilInterval(value: unknown): { start: string; end: string } | null {
	if (!isPlainObject(value) || !hasExactKeys(value, ['startDateTime', 'endDateTime'])) return null;
	const start = parseStructuredCivilDateTime(value.startDateTime);
	const end = parseStructuredCivilDateTime(value.endDateTime);
	return start !== null && end !== null && start < end ? { start, end } : null;
}

function parseInterval(value: unknown): ParsedInterval | null {
	if (
		!isPlainObject(value) ||
		!hasExactKeys(
			value,
			[],
			['physicalTimeInterval', 'civilDateTimeInterval', 'civilIso8601TimeInterval']
		) ||
		Object.keys(value).length === 0
	) {
		return null;
	}
	const physical =
		value.physicalTimeInterval === undefined
			? undefined
			: parsePhysicalInterval(value.physicalTimeInterval);
	const structuredCivil =
		value.civilDateTimeInterval === undefined
			? undefined
			: parseStructuredCivilInterval(value.civilDateTimeInterval);
	const isoCivil =
		value.civilIso8601TimeInterval === undefined
			? undefined
			: parseCivilInterval(value.civilIso8601TimeInterval);
	if (
		(value.physicalTimeInterval !== undefined && physical === null) ||
		(value.civilDateTimeInterval !== undefined && structuredCivil === null) ||
		(value.civilIso8601TimeInterval !== undefined && isoCivil === null)
	) {
		return null;
	}
	if (
		structuredCivil !== undefined &&
		structuredCivil !== null &&
		isoCivil !== undefined &&
		isoCivil !== null &&
		(structuredCivil.start !== isoCivil.start || structuredCivil.end !== isoCivil.end)
	) {
		return null;
	}
	return {
		...(physical === undefined || physical === null ? {} : { physical }),
		...(isoCivil !== undefined && isoCivil !== null
			? { civil: isoCivil }
			: structuredCivil === undefined || structuredCivil === null
				? {}
				: { civil: structuredCivil })
	};
}

function addDays(value: string, days: number): string {
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function isMidnightCivil(value: string): boolean {
	return value.length === 10 || value.endsWith('T00:00:00.000000000');
}

function selectWindow(
	definition: MetricDefinition,
	intervals: readonly ParsedInterval[]
): { start: string; end: string } | null {
	const needsDailyDates =
		definition.recordKind === 'daily' || definition.readMode === 'dailyRollUp';
	if (needsDailyDates || definition.filterStrategies.physical === undefined) {
		if (
			definition.filterStrategies.civil === undefined ||
			intervals.some((item) => item.civil === undefined)
		) {
			return null;
		}
		const starts = intervals.map((item) => item.civil?.start ?? '');
		const ends = intervals.map((item) => item.civil?.end ?? '');
		const start = starts.reduce((left, right) => (left < right ? left : right));
		const end = ends.reduce((left, right) => (left > right ? left : right));
		if (!needsDailyDates) return start.length > 10 && end.length > 10 ? { start, end } : null;
		const startDate = start.slice(0, 10);
		const endDate = isMidnightCivil(end) ? end.slice(0, 10) : addDays(end.slice(0, 10), 1);
		return { start: startDate, end: endDate <= startDate ? addDays(startDate, 1) : endDate };
	}
	if (intervals.every((item) => item.physical !== undefined)) {
		const starts = intervals.map((item) => item.physical?.start ?? '');
		const ends = intervals.map((item) => item.physical?.end ?? '');
		return {
			start: starts.reduce((left, right) => (left < right ? left : right)),
			end: ends.reduce((left, right) => (left > right ? left : right))
		};
	}
	if (
		definition.filterStrategies.civil !== undefined &&
		intervals.every((item) => item.civil !== undefined)
	) {
		const starts = intervals.map((item) => item.civil?.start ?? '');
		const ends = intervals.map((item) => item.civil?.end ?? '');
		return {
			start: starts.reduce((left, right) => (left < right ? left : right)),
			end: ends.reduce((left, right) => (left > right ? left : right))
		};
	}
	return null;
}

function parseNotification(value: unknown): NormalizedNotification | null {
	if (!isPlainObject(value) || !hasExactKeys(value, ['data']) || !isPlainObject(value.data)) {
		return null;
	}
	const data = value.data;
	if (
		!hasExactKeys(
			data,
			[
				'version',
				'clientProvidedSubscriptionName',
				'healthUserId',
				'operation',
				'dataType',
				'intervals'
			],
			['recordId']
		) ||
		data.version !== '1' ||
		boundedString(data.clientProvidedSubscriptionName, MAX_SUBSCRIPTION_NAME_LENGTH) === null ||
		typeof data.healthUserId !== 'string' ||
		!/^[A-Za-z0-9-]{1,63}$/.test(data.healthUserId) ||
		(data.operation !== 'UPSERT' && data.operation !== 'DELETE') ||
		typeof data.dataType !== 'string' ||
		!Array.isArray(data.intervals) ||
		data.intervals.length === 0 ||
		data.intervals.length > MAX_INTERVALS_PER_NOTIFICATION
	) {
		return null;
	}
	const definition = getMetricDefinition(data.dataType);
	if (definition === null || !definition.webhook) return null;
	const intervals: ParsedInterval[] = [];
	for (const value of data.intervals) {
		const interval = parseInterval(value);
		if (interval === null) return null;
		intervals.push(interval);
	}
	const window = selectWindow(definition, intervals);
	if (window === null || window.start >= window.end) return null;
	const recordId =
		data.recordId === undefined ? undefined : boundedString(data.recordId, MAX_RECORD_ID_LENGTH);
	if (
		(data.recordId !== undefined && recordId === null) ||
		(data.operation === 'UPSERT' && data.recordId !== undefined)
	)
		return null;
	return {
		healthUserId: data.healthUserId,
		dataType: data.dataType,
		operation: data.operation,
		windowStart: window.start,
		windowEnd: window.end,
		...(recordId === undefined || recordId === null ? {} : { recordId })
	};
}

function parseNotifications(value: unknown): NormalizedNotification[] | null {
	const batch = Array.isArray(value) ? value : [value];
	if (batch.length === 0 || batch.length > MAX_BATCH_SIZE) return null;
	const notifications: NormalizedNotification[] = [];
	let totalIntervals = 0;
	for (const item of batch) {
		const parsed = parseNotification(item);
		if (parsed === null) return null;
		const data = isPlainObject(item) && isPlainObject(item.data) ? item.data : null;
		if (data === null || !Array.isArray(data.intervals)) return null;
		totalIntervals += data.intervals.length;
		if (totalIntervals > MAX_TOTAL_INTERVALS) return null;
		notifications.push(parsed);
	}
	return notifications;
}

function mergeWindow(
	start: string,
	end: string,
	incomingStart: string,
	incomingEnd: string
): { start: string; end: string } {
	return {
		start: start < incomingStart ? start : incomingStart,
		end: end > incomingEnd ? end : incomingEnd
	};
}

async function queueIncrementalCursor(
	ctx: MutationCtx,
	args: {
		connection: Doc<'googleHealthConnections'>;
		dataType: string;
		windowStart: string;
		windowEnd: string;
	}
): Promise<Id<'googleHealthSyncCursors'> | null> {
	const existing = await ctx.db
		.query('googleHealthSyncCursors')
		.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
			q
				.eq('connectionId', args.connection._id)
				.eq('dataType', args.dataType)
				.eq('mode', 'incremental')
		)
		.unique();
	const now = Date.now();
	if (!existing) {
		const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
			connectionId: args.connection._id,
			userId: args.connection.userId,
			dataType: args.dataType,
			mode: 'incremental',
			status: 'queued',
			windowStart: args.windowStart,
			windowEnd: args.windowEnd,
			syncId: `webhook:${args.connection.generation}:${args.dataType}:${now}`,
			attempt: 0,
			generation: args.connection.generation,
			updatedAt: now
		});
		return cursorId;
	}
	if (existing.generation !== args.connection.generation) {
		if (existing.activeRunId !== undefined) {
			const staleRun = await ctx.db.get('googleHealthSyncRuns', existing.activeRunId);
			if (staleRun?.status === 'running') {
				await ctx.db.patch('googleHealthSyncRuns', staleRun._id, {
					status: 'failed',
					finishedAt: now,
					errorCode: 'stale_generation',
					errorMessage: 'Google Health connection generation changed'
				});
			}
		}
		if (args.connection.activeSyncCursorId === existing._id) {
			await ctx.db.patch('googleHealthConnections', args.connection._id, {
				activeSyncCursorId: undefined,
				activeSyncRunId: undefined,
				syncLeaseExpiresAt: undefined
			});
		}
		await ctx.db.patch('googleHealthSyncCursors', existing._id, {
			status: 'queued',
			pageToken: undefined,
			windowStart: args.windowStart,
			windowEnd: args.windowEnd,
			pendingWindowStart: undefined,
			pendingWindowEnd: undefined,
			activeRunId: undefined,
			activeEpoch: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			hadMalformed: false,
			syncId: `webhook:${args.connection.generation}:${args.dataType}:${now}`,
			attempt: 0,
			generation: args.connection.generation,
			updatedAt: now
		});
		return existing._id;
	}
	const mustDefer =
		existing.status === 'running' ||
		existing.status === 'retry' ||
		existing.pageToken !== undefined ||
		existing.activeEpoch !== undefined;
	if (mustDefer) {
		const pending =
			existing.pendingWindowStart === undefined || existing.pendingWindowEnd === undefined
				? { start: args.windowStart, end: args.windowEnd }
				: mergeWindow(
						existing.pendingWindowStart,
						existing.pendingWindowEnd,
						args.windowStart,
						args.windowEnd
					);
		await ctx.db.patch('googleHealthSyncCursors', existing._id, {
			pendingWindowStart: pending.start,
			pendingWindowEnd: pending.end,
			updatedAt: now
		});
		return null;
	}
	const window =
		existing.status === 'queued' &&
		existing.windowStart !== undefined &&
		existing.windowEnd !== undefined
			? mergeWindow(existing.windowStart, existing.windowEnd, args.windowStart, args.windowEnd)
			: { start: args.windowStart, end: args.windowEnd };
	const shouldSchedule = existing.status !== 'queued';
	await ctx.db.patch('googleHealthSyncCursors', existing._id, {
		status: 'queued',
		windowStart: window.start,
		windowEnd: window.end,
		pendingWindowStart: undefined,
		pendingWindowEnd: undefined,
		syncId: `webhook:${args.connection.generation}:${args.dataType}:${now}`,
		attempt: 0,
		updatedAt: now
	});
	return shouldSchedule ? existing._id : null;
}

function recordNameCandidates(healthUserId: string, dataType: string, recordId: string): string[] {
	if (recordId.startsWith('users/')) return [recordId];
	return [
		`users/${healthUserId}/dataTypes/${dataType}/dataPoints/${recordId}`,
		`users/me/dataTypes/${dataType}/dataPoints/${recordId}`,
		recordId
	];
}

export const queueNotifications = internalMutation({
	args: { notifications: v.array(normalizedNotificationValidator) },
	returns: v.number(),
	handler: async (ctx, args): Promise<number> => {
		if (args.notifications.length === 0 || args.notifications.length > MAX_BATCH_SIZE) {
			throw new Error('invalid Google Health webhook batch size');
		}
		let accepted = 0;
		for (const notification of args.notifications) {
			const connections = await ctx.db
				.query('googleHealthConnections')
				.withIndex('by_healthUserId', (q) => q.eq('healthUserId', notification.healthUserId))
				.take(2);
			if (connections.length !== 1) continue;
			const connection = connections[0];
			const definition = getMetricDefinition(notification.dataType);
			if (
				definition === null ||
				!definition.webhook ||
				!connection.grantedScopes.includes(definition.scope) ||
				!SYNCABLE_STATUSES.has(connection.status)
			) {
				continue;
			}
			if (notification.operation === 'DELETE' && notification.recordId !== undefined) {
				await deleteNamedGooglePoint(ctx, {
					connection,
					dataType: notification.dataType,
					googleDataPointNames: recordNameCandidates(
						notification.healthUserId,
						notification.dataType,
						notification.recordId
					)
				});
			}
			const cursorId = await queueIncrementalCursor(ctx, {
				connection,
				dataType: notification.dataType,
				windowStart: notification.windowStart,
				windowEnd: notification.windowEnd
			});
			if (cursorId !== null) {
				await ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, {
					cursorId,
					generation: connection.generation,
					trigger: 'webhook'
				});
			}
			accepted += 1;
		}
		return accepted;
	}
});

async function fetchPublicKeyset(): Promise<unknown | null> {
	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort();
			reject(new Error('Google Health keyset request timed out'));
		}, KEYSET_TIMEOUT_MS);
	});
	try {
		const response = await Promise.race([
			fetch(PUBLIC_KEYSET_URL, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				signal: controller.signal
			}),
			timeout
		]);
		if (!response.ok || response.body === null) return null;
		const contentLength = response.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > MAX_KEYSET_BYTES) {
				return null;
			}
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		let complete = false;
		try {
			while (true) {
				const result = await Promise.race([reader.read(), timeout]);
				if (result.done) {
					complete = true;
					break;
				}
				total += result.value.byteLength;
				if (total > MAX_KEYSET_BYTES) return null;
				chunks.push(result.value);
			}
		} finally {
			if (complete) reader.releaseLock();
			else void reader.cancel().catch(() => undefined);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return JSON.parse(text);
	} catch {
		return null;
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

async function getPublicKeyset(forceRefresh: boolean): Promise<unknown | null> {
	const now = Date.now();
	if (!forceRefresh && cachedKeyset !== null && cachedKeyset.expiresAt > now) {
		return cachedKeyset.value;
	}
	const value = await fetchPublicKeyset();
	if (value === null) return null;
	cachedKeyset = { value, expiresAt: now + KEYSET_CACHE_MS };
	return value;
}

export const verifyAndQueue = internalAction({
	args: {
		rawBody: v.string(),
		authorization: v.optional(v.string()),
		signature: v.optional(v.string())
	},
	returns: webhookResultValidator,
	handler: async (ctx, args): Promise<WebhookResult> => {
		if (
			new TextEncoder().encode(args.rawBody).byteLength > MAX_RAW_BODY_BYTES ||
			!constantTimeAuthorizationMatches(args.authorization)
		) {
			return { kind: 'unauthorized', accepted: 0 };
		}
		let value: unknown;
		try {
			value = JSON.parse(args.rawBody);
		} catch {
			return { kind: 'invalid', accepted: 0 };
		}
		if (isPlainObject(value) && 'type' in value) {
			return hasExactKeys(value, ['type']) && value.type === 'verification'
				? { kind: 'verification', accepted: 0 }
				: { kind: 'invalid', accepted: 0 };
		}
		if (args.signature === undefined || args.signature.length > MAX_SIGNATURE_LENGTH) {
			return { kind: 'unauthorized', accepted: 0 };
		}
		const keyset = await getPublicKeyset(false);
		if (keyset === null) return { kind: 'unauthorized', accepted: 0 };
		let verified = await verifyGoogleHealthSignature(args.rawBody, args.signature, keyset);
		if (!verified) {
			const refreshedKeyset = await getPublicKeyset(true);
			verified =
				refreshedKeyset !== null &&
				(await verifyGoogleHealthSignature(args.rawBody, args.signature, refreshedKeyset));
		}
		if (!verified) {
			return { kind: 'unauthorized', accepted: 0 };
		}
		const notifications = parseNotifications(value);
		if (notifications === null) return { kind: 'invalid', accepted: 0 };
		const accepted: number = await ctx.runMutation(
			internal.googleHealth.webhook.queueNotifications,
			{
				notifications
			}
		);
		return { kind: 'notification', accepted };
	}
});
