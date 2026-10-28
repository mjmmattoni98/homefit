import { canonicalPhysicalCoverageKey } from './normalize';
import { getMetricDefinition, type MetricDefinition } from './registry';

const MAX_BATCH_SIZE = 99;
const MAX_INTERVALS_PER_NOTIFICATION = 16;
const MAX_TOTAL_INTERVALS = 256;
const MAX_SUBSCRIPTION_NAME_LENGTH = 512;
const MAX_RECORD_ID_LENGTH = 1024;

type PlainObject = Record<string, unknown>;
export type NormalizedNotification = {
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

function addNanosecond(value: string): string | null {
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{9})(Z?)$/.exec(value);
	if (match === null) return null;
	const nanoseconds = Number(match[2]);
	if (nanoseconds < 999_999_999) {
		return `${match[1]}.${String(nanoseconds + 1).padStart(9, '0')}${match[3]}`;
	}
	const physical = match[3] === 'Z';
	const instant = new Date(`${match[1]}Z`);
	if (Number.isNaN(instant.getTime())) return null;
	instant.setUTCSeconds(instant.getUTCSeconds() + 1);
	if (instant.getUTCFullYear() < 1 || instant.getUTCFullYear() > 9999) return null;
	return `${instant.toISOString().slice(0, 19)}.000000000${physical ? 'Z' : ''}`;
}

function widenEndForSelector(
	strategy: MetricDefinition['filterStrategies']['physical'],
	end: string
): string | null {
	if (strategy?.selector !== 'end' || strategy.comparison !== 'closedOpen') return end;
	return addNanosecond(end);
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
		if (!needsDailyDates) {
			const widenedEnd = widenEndForSelector(definition.filterStrategies.civil, end);
			return start.length > 10 && widenedEnd !== null && widenedEnd.length > 10
				? { start, end: widenedEnd }
				: null;
		}
		const startDate = start.slice(0, 10);
		const endDate = isMidnightCivil(end) ? end.slice(0, 10) : addDays(end.slice(0, 10), 1);
		return { start: startDate, end: endDate <= startDate ? addDays(startDate, 1) : endDate };
	}
	if (intervals.every((item) => item.physical !== undefined)) {
		const starts = intervals.map((item) => item.physical?.start ?? '');
		const ends = intervals.map((item) => item.physical?.end ?? '');
		const end = ends.reduce((left, right) => (left > right ? left : right));
		const widenedEnd = widenEndForSelector(definition.filterStrategies.physical, end);
		return widenedEnd === null
			? null
			: {
					start: starts.reduce((left, right) => (left < right ? left : right)),
					end: widenedEnd
				};
	}
	if (
		definition.filterStrategies.civil !== undefined &&
		intervals.every((item) => item.civil !== undefined)
	) {
		const starts = intervals.map((item) => item.civil?.start ?? '');
		const ends = intervals.map((item) => item.civil?.end ?? '');
		const end = ends.reduce((left, right) => (left > right ? left : right));
		const widenedEnd = widenEndForSelector(definition.filterStrategies.civil, end);
		return widenedEnd === null
			? null
			: {
					start: starts.reduce((left, right) => (left < right ? left : right)),
					end: widenedEnd
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
	if (data.recordId !== undefined && recordId === null) return null;
	return {
		healthUserId: data.healthUserId,
		dataType: data.dataType,
		operation: data.operation,
		windowStart: window.start,
		windowEnd: window.end,
		...(recordId === undefined || recordId === null ? {} : { recordId })
	};
}

/** Validates a webhook batch and maps every notification to the window it affects. */
export function parseNotifications(value: unknown): NormalizedNotification[] | null {
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

/** Resource names a webhook `recordId` may correspond to in stored data points. */
export function recordNameCandidates(
	healthUserId: string,
	dataType: string,
	recordId: string
): string[] {
	if (recordId.startsWith('users/')) return [recordId];
	return [
		`users/${healthUserId}/dataTypes/${dataType}/dataPoints/${recordId}`,
		`users/me/dataTypes/${dataType}/dataPoints/${recordId}`,
		recordId
	];
}
