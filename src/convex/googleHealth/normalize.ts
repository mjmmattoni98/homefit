import type { MetricDefinition } from './registry';
import type { NormalizedHealthPoint } from './validators';

const MAX_PAYLOAD_BYTES = 750 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_METADATA_LENGTH = 512;
const ALL_SOURCES_FAMILY = 'users/me/dataSourceFamilies/all-sources';

const SHA256_CONSTANTS = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

const SHA256_INITIAL_STATE = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
] as const;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type PlainObject = Record<string, unknown>;

type RecordIdentity =
	| { kind: 'named'; name: string }
	| { kind: 'sample'; time: string; subtype: string; sourceFamily?: string }
	| { kind: 'interval'; start: string; end: string; subtype: string; sourceFamily?: string }
	| {
			kind: 'daily';
			date: string;
			windowStart?: string;
			windowEnd?: string;
			subtype: string;
			sourceFamily?: string;
	  }
	| { kind: 'session'; start: string; end: string; subtype: string; sourceFamily?: string }
	| { kind: 'reference'; nameOrCanonicalId: string; sourceFamily?: string };

export interface NormalizeGooglePointOptions {
	readonly sourceFamily?: string;
}

interface CivilDateTime {
	readonly iso: string;
	readonly localDate: string;
	readonly epochMs: number;
	readonly subMillisecondNanos: number;
}

interface Instant {
	readonly identity: string;
	readonly epochMs: number;
	readonly subMillisecondNanos: number;
	readonly localDate: string;
}

interface PhysicalTimestamp {
	readonly identity: string;
	readonly sortKey: string;
	readonly epochMs: number;
	readonly subMillisecondNanos: number;
}

interface NormalizedTime {
	readonly identity: RecordIdentity;
	readonly recordTimestamp: number;
	readonly localDate: string;
	readonly startTime?: number;
	readonly endTime?: number;
}

interface OrderedTime {
	readonly epochMs: number;
	readonly subMillisecondNanos: number;
}

function isPlainObject(value: unknown): value is PlainObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalidJson(message: string): Error {
	return new Error(
		`Google Health payload must contain only plain JSON-compatible values: ${message}`
	);
}

function toCanonicalJsonValue(
	value: unknown,
	ancestors: WeakSet<object>,
	depth: number
): JsonValue {
	if (depth > MAX_JSON_DEPTH) {
		throw invalidJson(`nesting exceeds ${MAX_JSON_DEPTH} levels`);
	}

	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw invalidJson('numbers must be finite');
		}
		return Object.is(value, -0) ? 0 : value;
	}

	if (typeof value !== 'object') {
		throw invalidJson(`unsupported ${typeof value} value`);
	}

	if (ancestors.has(value)) {
		throw invalidJson('cyclic input is not supported');
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const keys = Object.keys(value);
			if (
				keys.length !== value.length ||
				keys.some((key, index) => key !== String(index)) ||
				Object.getOwnPropertySymbols(value).length > 0
			) {
				throw invalidJson('arrays cannot contain holes or extra properties');
			}
			return value.map((item) => toCanonicalJsonValue(item, ancestors, depth + 1));
		}

		if (!isPlainObject(value)) {
			throw invalidJson('objects cannot have a custom prototype');
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw invalidJson('symbol properties are not supported');
		}

		const result = Object.create(null) as { [key: string]: JsonValue };
		for (const key of Object.keys(value).sort()) {
			result[key] = toCanonicalJsonValue(value[key], ancestors, depth + 1);
		}
		return result;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(toCanonicalJsonValue(value, new WeakSet(), 0));
}

function rotateRight(value: number, amount: number): number {
	return (value >>> amount) | (value << (32 - amount));
}

function sha256Bytes(value: string): Uint8Array {
	const input = new TextEncoder().encode(value);
	const bitLength = input.byteLength * 8;
	const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.byteLength] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
	view.setUint32(paddedLength - 4, bitLength >>> 0, false);

	const state: number[] = [...SHA256_INITIAL_STATE];
	const words = new Uint32Array(64);
	for (let offset = 0; offset < paddedLength; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			words[index] = view.getUint32(offset + index * 4, false);
		}
		for (let index = 16; index < 64; index += 1) {
			const previous15 = words[index - 15];
			const previous2 = words[index - 2];
			const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
			const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
			words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
		}

		let [a, b, c, d, e, f, g, h] = state;
		for (let index = 0; index < 64; index += 1) {
			const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
			const choice = (e & f) ^ (~e & g);
			const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
			const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
			const majority = (a & b) ^ (a & c) ^ (b & c);
			const temporary2 = (sum0 + majority) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temporary1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temporary1 + temporary2) >>> 0;
		}

		state[0] = (state[0] + a) >>> 0;
		state[1] = (state[1] + b) >>> 0;
		state[2] = (state[2] + c) >>> 0;
		state[3] = (state[3] + d) >>> 0;
		state[4] = (state[4] + e) >>> 0;
		state[5] = (state[5] + f) >>> 0;
		state[6] = (state[6] + g) >>> 0;
		state[7] = (state[7] + h) >>> 0;
	}

	const digest = new Uint8Array(32);
	const digestView = new DataView(digest.buffer);
	state.forEach((word, index) => digestView.setUint32(index * 4, word, false));
	return digest;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let output = '';
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index];
		const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
		const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
		const combined = (first << 16) | (second << 8) | third;
		output += BASE64URL_ALPHABET[(combined >>> 18) & 63];
		output += BASE64URL_ALPHABET[(combined >>> 12) & 63];
		if (index + 1 < bytes.length) output += BASE64URL_ALPHABET[(combined >>> 6) & 63];
		if (index + 2 < bytes.length) output += BASE64URL_ALPHABET[combined & 63];
	}
	return output;
}

export function sha256Base64Url(value: string): string {
	return bytesToBase64Url(sha256Bytes(value));
}

function safeString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_METADATA_LENGTH ? trimmed : undefined;
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, '0');
}

function validDate(year: number, month: number, day: number): boolean {
	if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
	if (!Number.isInteger(month) || month < 1 || month > 12) return false;
	if (!Number.isInteger(day) || day < 1 || day > 31) return false;
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(year, month - 1, day);
	return (
		date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
	);
}

function civilEpoch(
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes: number,
	seconds: number,
	nanos: number
): number {
	const date = new Date(0);
	date.setUTCHours(hours, minutes, seconds, Math.floor(nanos / 1_000_000));
	date.setUTCFullYear(year, month - 1, day);
	return date.getTime();
}

function parseTimestamp(value: unknown): PhysicalTimestamp | undefined {
	if (typeof value !== 'string') return undefined;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
			value
		);
	if (match === null) return undefined;

	const [, yearText, monthText, dayText, hoursText, minutesText, secondsText, fraction, zone] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hours = Number(hoursText);
	const minutes = Number(minutesText);
	const seconds = Number(secondsText);
	if (!validDate(year, month, day) || hours > 23 || minutes > 59 || seconds > 59) {
		return undefined;
	}

	let offsetSeconds = 0;
	if (zone !== 'Z') {
		const offsetHours = Number(zone.slice(1, 3));
		const offsetMinutes = Number(zone.slice(4, 6));
		if (offsetHours > 23 || offsetMinutes > 59) return undefined;
		const direction = zone[0] === '+' ? 1 : -1;
		offsetSeconds = direction * (offsetHours * 60 + offsetMinutes) * 60;
	}

	const nanos = Number((fraction ?? '').padEnd(9, '0'));
	const wholeSecondEpoch =
		civilEpoch(year, month, day, hours, minutes, seconds, 0) - offsetSeconds * 1000;
	const utcDate = new Date(wholeSecondEpoch);
	if (utcDate.getUTCFullYear() < 1 || utcDate.getUTCFullYear() > 9999) return undefined;
	const utcSecond = utcDate.toISOString().slice(0, 19);
	const canonicalFraction = nanos === 0 ? '' : `.${pad(nanos, 9).replace(/0+$/, '')}`;
	return {
		identity: `${utcSecond}${canonicalFraction}Z`,
		sortKey: `${utcSecond}.${pad(nanos, 9)}Z`,
		epochMs: wholeSecondEpoch + Math.floor(nanos / 1_000_000),
		subMillisecondNanos: nanos % 1_000_000
	};
}

function parseCivilString(value: string): CivilDateTime | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/.exec(
		value
	);
	if (match === null) return undefined;

	const [, yearText, monthText, dayText, hoursText, minutesText, secondsText, nanosText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hours = Number(hoursText ?? 0);
	const minutes = Number(minutesText ?? 0);
	const seconds = Number(secondsText ?? 0);
	const nanos = Number((nanosText ?? '').padEnd(9, '0'));
	if (
		!validDate(year, month, day) ||
		!Number.isInteger(hours) ||
		hours < 0 ||
		hours > 23 ||
		!Number.isInteger(minutes) ||
		minutes < 0 ||
		minutes > 59 ||
		!Number.isInteger(seconds) ||
		seconds < 0 ||
		seconds > 59
	) {
		return undefined;
	}

	const localDate = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
	const time = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
	const fraction = nanos === 0 ? '' : `.${pad(nanos, 9).replace(/0+$/, '')}`;
	return {
		iso: `${localDate}T${time}${fraction}`,
		localDate,
		epochMs: civilEpoch(year, month, day, hours, minutes, seconds, nanos),
		subMillisecondNanos: nanos % 1_000_000
	};
}

function parseCivilDateTime(value: unknown): CivilDateTime | undefined {
	if (typeof value === 'string') return parseCivilString(value);
	if (!isPlainObject(value)) return undefined;

	const date = value.date;
	if (typeof date === 'string') {
		const parsedDate = parseCivilString(date);
		if (parsedDate === undefined) return undefined;
		if (value.time === undefined) return parsedDate;
	}
	if (!isPlainObject(date)) return undefined;

	const { year, month, day } = date;
	const time = value.time;
	if (time !== undefined && !isPlainObject(time)) return undefined;
	const hours = isPlainObject(time) && typeof time.hours === 'number' ? time.hours : 0;
	const minutes = isPlainObject(time) && typeof time.minutes === 'number' ? time.minutes : 0;
	const seconds = isPlainObject(time) && typeof time.seconds === 'number' ? time.seconds : 0;
	const nanos = isPlainObject(time) && typeof time.nanos === 'number' ? time.nanos : 0;
	if (
		typeof year !== 'number' ||
		typeof month !== 'number' ||
		typeof day !== 'number' ||
		!validDate(year, month, day) ||
		!Number.isInteger(hours) ||
		hours < 0 ||
		hours > 23 ||
		!Number.isInteger(minutes) ||
		minutes < 0 ||
		minutes > 59 ||
		!Number.isInteger(seconds) ||
		seconds < 0 ||
		seconds > 59 ||
		!Number.isInteger(nanos) ||
		nanos < 0 ||
		nanos > 999_999_999
	) {
		return undefined;
	}

	const localDate = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
	const timeText = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
	const fraction = nanos === 0 ? '' : `.${pad(nanos, 9).replace(/0+$/, '')}`;
	return {
		iso: `${localDate}T${timeText}${fraction}`,
		localDate,
		epochMs: civilEpoch(year, month, day, hours, minutes, seconds, nanos),
		subMillisecondNanos: nanos % 1_000_000
	};
}

function parseDateOnly(value: unknown): CivilDateTime | undefined {
	if (typeof value === 'string') {
		return /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseCivilString(value) : undefined;
	}
	if (!isPlainObject(value)) return undefined;
	return parseCivilDateTime({ date: value });
}

function parseUtcOffset(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const match = /^(-?\d+(?:\.\d+)?)s$/.exec(value);
	if (match === null) return undefined;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) && Math.abs(seconds) <= 86_400 ? seconds : undefined;
}

function localDateFromEpoch(timestamp: number, offsetSeconds = 0): string {
	return new Date(timestamp + offsetSeconds * 1000).toISOString().slice(0, 10);
}

function normalizeInstant(
	physicalValue: unknown,
	civilValue: unknown,
	offsetValue: unknown
): Instant | undefined {
	const physicalTimestamp = parseTimestamp(physicalValue);
	const civil = parseCivilDateTime(civilValue);
	if (physicalTimestamp !== undefined) {
		return {
			identity: physicalTimestamp.identity,
			epochMs: physicalTimestamp.epochMs,
			subMillisecondNanos: physicalTimestamp.subMillisecondNanos,
			localDate:
				civil?.localDate ??
				localDateFromEpoch(physicalTimestamp.epochMs, parseUtcOffset(offsetValue) ?? 0)
		};
	}
	if (civil !== undefined) {
		return {
			identity: `civil:${civil.iso}`,
			epochMs: civil.epochMs,
			subMillisecondNanos: civil.subMillisecondNanos,
			localDate: civil.localDate
		};
	}
	return undefined;
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
	let current = value;
	for (const field of path) {
		if (!isPlainObject(current)) return undefined;
		current = current[field];
	}
	return current;
}

function semanticSubtype(definition: MetricDefinition, payload: PlainObject): string {
	const values = definition.identityStrategy.components.flatMap((component) => {
		const paths = component.kind === 'value' ? [component.path] : component.paths;
		for (const path of paths) {
			const value = valueAtPath(payload, path);
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				return [{ path: path.join('.'), value }];
			}
		}
		return [];
	});
	return values.length === 0 ? '' : canonicalJson(values);
}

function precedes(left: OrderedTime, right: OrderedTime): boolean {
	return (
		left.epochMs < right.epochMs ||
		(left.epochMs === right.epochMs && left.subMillisecondNanos < right.subMillisecondNanos)
	);
}

function withSourceFamily(
	identity: Exclude<RecordIdentity, { kind: 'named' }>,
	sourceFamily: string | undefined
): Exclude<RecordIdentity, { kind: 'named' }> {
	return {
		...identity,
		...(sourceFamily === undefined ? {} : { sourceFamily })
	};
}

function normalizeRecordTime(
	definition: MetricDefinition,
	payload: PlainObject,
	raw: PlainObject,
	sourceFamily: string | undefined
): NormalizedTime {
	const subtype = semanticSubtype(definition, payload);
	if (definition.recordKind === 'sample') {
		const sampleTime = isPlainObject(payload.sampleTime) ? payload.sampleTime : undefined;
		const instant =
			sampleTime === undefined
				? undefined
				: normalizeInstant(sampleTime.physicalTime, sampleTime.civilTime, sampleTime.utcOffset);
		if (instant === undefined) throw new Error('Google Health sample has no usable time');
		return {
			identity: withSourceFamily({ kind: 'sample', time: instant.identity, subtype }, sourceFamily),
			recordTimestamp: instant.epochMs,
			localDate: instant.localDate
		};
	}

	if (definition.recordKind === 'interval' || definition.recordKind === 'session') {
		const interval = isPlainObject(payload.interval)
			? payload.interval
			: isPlainObject(payload.sessionTime)
				? payload.sessionTime
				: undefined;
		const start =
			interval === undefined
				? undefined
				: normalizeInstant(interval.startTime, interval.civilStartTime, interval.startUtcOffset);
		const end =
			interval === undefined
				? undefined
				: normalizeInstant(interval.endTime, interval.civilEndTime, interval.endUtcOffset);
		if (start === undefined || end === undefined) {
			throw new Error(`Google Health ${definition.recordKind} has no usable time interval`);
		}
		if (precedes(end, start)) {
			throw new Error(`Google Health ${definition.recordKind} end precedes start`);
		}
		const kind = definition.recordKind;
		return {
			identity: withSourceFamily(
				{ kind, start: start.identity, end: end.identity, subtype },
				sourceFamily
			),
			recordTimestamp: start.epochMs,
			localDate: start.localDate,
			startTime: start.epochMs,
			endTime: end.epochMs
		};
	}

	if (definition.recordKind === 'daily') {
		const isRollup = definition.readMode === 'dailyRollUp';
		const civilStart =
			parseCivilDateTime(payload.civilStartTime) ?? parseCivilDateTime(raw.civilStartTime);
		const date =
			(isRollup ? civilStart : undefined) ??
			parseDateOnly(payload.date) ??
			parseDateOnly(raw.date) ??
			civilStart;
		if (date === undefined) throw new Error('Google Health daily record has no usable date');
		const end = parseCivilDateTime(payload.civilEndTime) ?? parseCivilDateTime(raw.civilEndTime);
		if (isRollup && end === undefined) {
			throw new Error('Google Health daily rollup has no usable civil end time');
		}
		if (isRollup && end !== undefined && precedes(end, date)) {
			throw new Error('Google Health daily rollup end precedes start');
		}
		return {
			identity: withSourceFamily(
				{
					kind: 'daily',
					date: date.localDate,
					...(isRollup ? { windowStart: date.iso } : {}),
					...(isRollup && end !== undefined ? { windowEnd: end.iso } : {}),
					subtype
				},
				sourceFamily
			),
			recordTimestamp: date.epochMs,
			localDate: date.localDate,
			...(end === undefined ? {} : { startTime: date.epochMs, endTime: end.epochMs })
		};
	}

	const referenceName = safeString(raw.name) ?? safeString(raw.dataPointName);
	if (referenceName === undefined) {
		throw new Error('Google Health reference record requires a resource name');
	}
	return {
		identity: withSourceFamily(
			{
				kind: 'reference',
				nameOrCanonicalId: referenceName
			},
			sourceFamily
		),
		recordTimestamp: 0,
		localDate: '1970-01-01'
	};
}

function parseNumeric(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value !== 'string' || !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) {
		return undefined;
	}
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : undefined;
}

function parseDurationSeconds(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined;
	const match = /^(\d+)(?:\.(\d{1,9}))?s$/.exec(value);
	if (match === null) return undefined;
	const seconds = Number(match[1]);
	const nanos = Number((match[2] ?? '').padEnd(9, '0'));
	const duration = seconds + nanos / 1_000_000_000;
	return Number.isSafeInteger(seconds) && Number.isFinite(duration) ? duration : undefined;
}

function derivePrimaryValue(
	definition: MetricDefinition,
	payload: PlainObject,
	normalizedTime: NormalizedTime
): number | undefined {
	const strategy = definition.primaryValueStrategy;
	if (strategy === undefined) return undefined;
	if (strategy.kind === 'direct') {
		const sourceValue = parseNumeric(valueAtPath(payload, strategy.path));
		if (sourceValue === undefined) return undefined;
		const primaryValue = sourceValue * strategy.multiplier;
		return Number.isFinite(primaryValue) ? primaryValue : undefined;
	}
	if (strategy.kind === 'sum') {
		const values = valueAtPath(payload, strategy.arrayPath);
		if (!Array.isArray(values)) return undefined;
		let found = false;
		let sum = 0;
		for (const item of values) {
			const numeric = parseNumeric(valueAtPath(item, strategy.valuePath));
			if (numeric === undefined) return undefined;
			found = true;
			sum += numeric;
		}
		const primaryValue = sum * strategy.multiplier;
		return found && Number.isFinite(primaryValue) ? primaryValue : undefined;
	}

	const durationSeconds = parseDurationSeconds(valueAtPath(payload, strategy.path));
	if (durationSeconds !== undefined) {
		const primaryValue = durationSeconds * strategy.secondsMultiplier;
		return Number.isFinite(primaryValue) ? primaryValue : undefined;
	}
	if (
		strategy.intervalFallback &&
		normalizedTime.startTime !== undefined &&
		normalizedTime.endTime !== undefined
	) {
		return (
			((normalizedTime.endTime - normalizedTime.startTime) / 1000) * strategy.secondsMultiplier
		);
	}
	return undefined;
}

function sourceMetadata(
	definition: MetricDefinition,
	raw: PlainObject
): Pick<
	NormalizedHealthPoint,
	'sourcePlatform' | 'sourceApplication' | 'sourceDevice' | 'recordingMethod'
> {
	if (definition.readMode !== 'list') return {};
	const dataSource = isPlainObject(raw.dataSource) ? raw.dataSource : undefined;
	if (dataSource === undefined) return {};
	const application = isPlainObject(dataSource.application) ? dataSource.application : undefined;
	const device = isPlainObject(dataSource.device) ? dataSource.device : undefined;
	const sourcePlatform = safeString(dataSource.platform);
	const recordingMethod = safeString(dataSource.recordingMethod);
	const sourceApplication =
		safeString(application?.packageName) ??
		safeString(application?.webClientId) ??
		safeString(application?.googleWebClientId);
	const sourceDevice =
		safeString(device?.displayName) ??
		safeString(device?.manufacturer) ??
		safeString(device?.formFactor);

	return {
		...(sourcePlatform === undefined ? {} : { sourcePlatform }),
		...(sourceApplication === undefined ? {} : { sourceApplication }),
		...(sourceDevice === undefined ? {} : { sourceDevice }),
		...(recordingMethod === undefined ? {} : { recordingMethod })
	};
}

export function canonicalPhysicalCoverageKey(value: string): string | undefined {
	return parseTimestamp(value)?.sortKey;
}

function coverageMetadata(
	definition: MetricDefinition,
	payload: PlainObject,
	raw: PlainObject
): Pick<NormalizedHealthPoint, 'physicalCoverageKey' | 'civilCoverageTime'> {
	const strategies = definition.filterStrategies;
	if (strategies.physical === undefined && strategies.civil === undefined) return {};
	if (definition.recordKind === 'daily') {
		const civil =
			parseDateOnly(payload.date) ??
			parseDateOnly(raw.date) ??
			parseCivilDateTime(payload.civilStartTime) ??
			parseCivilDateTime(raw.civilStartTime);
		return civil === undefined ? {} : { civilCoverageTime: civil.iso };
	}

	const time =
		definition.recordKind === 'sample'
			? isPlainObject(payload.sampleTime)
				? payload.sampleTime
				: undefined
			: isPlainObject(payload.interval)
				? payload.interval
				: isPlainObject(payload.sessionTime)
					? payload.sessionTime
					: undefined;
	if (time === undefined) return {};
	const selector = strategies.physical?.selector ?? strategies.civil?.selector;
	const physicalValue =
		selector === 'end' ? time.endTime : selector === 'sample' ? time.physicalTime : time.startTime;
	const civilValue =
		selector === 'end'
			? time.civilEndTime
			: selector === 'sample'
				? time.civilTime
				: time.civilStartTime;
	const physical = strategies.physical === undefined ? undefined : parseTimestamp(physicalValue);
	const civil = strategies.civil === undefined ? undefined : parseCivilDateTime(civilValue);
	return {
		...(physical === undefined ? {} : { physicalCoverageKey: physical.sortKey }),
		...(civil === undefined ? {} : { civilCoverageTime: civil.iso })
	};
}

export function normalizeGooglePoint(
	definition: MetricDefinition,
	raw: unknown,
	options: NormalizeGooglePointOptions = {}
): NormalizedHealthPoint {
	if (!isPlainObject(raw)) throw new Error('Google Health data point must be a plain object');
	const payload = raw[definition.payloadField];
	if (!isPlainObject(payload)) {
		throw new Error(`Google Health data point is missing plain-object ${definition.payloadField}`);
	}

	const sourceFamily =
		options.sourceFamily === undefined
			? definition.readMode === 'list'
				? undefined
				: ALL_SOURCES_FAMILY
			: safeString(options.sourceFamily);
	if (options.sourceFamily !== undefined && sourceFamily === undefined) {
		throw new Error('Google Health source family must be a non-empty bounded string');
	}

	const payloadJson = canonicalJson(raw);
	if (new TextEncoder().encode(payloadJson).byteLength > MAX_PAYLOAD_BYTES) {
		throw new Error('Google Health payload exceeds the 750 KiB storage limit');
	}
	const payloadDigest = sha256Base64Url(payloadJson);
	const googleDataPointName = safeString(raw.name) ?? safeString(raw.dataPointName);
	const normalizedTime = normalizeRecordTime(definition, payload, raw, sourceFamily);
	const stablePayloadIdentity =
		definition.identityStrategy.stableReferencePath === undefined
			? undefined
			: safeString(valueAtPath(payload, definition.identityStrategy.stableReferencePath));
	const identity: RecordIdentity =
		googleDataPointName !== undefined
			? { kind: 'named', name: googleDataPointName }
			: stablePayloadIdentity !== undefined
				? withSourceFamily(
						{ kind: 'reference', nameOrCanonicalId: stablePayloadIdentity },
						sourceFamily
					)
				: normalizedTime.identity;
	const primaryValue = derivePrimaryValue(definition, payload, normalizedTime);
	const googleCreateTime = definition.payloadLifecycleTimestamps
		? parseTimestamp(payload.createTime)
		: undefined;
	const googleUpdateTime = definition.payloadLifecycleTimestamps
		? parseTimestamp(payload.updateTime)
		: undefined;

	return {
		provider: 'google_health',
		recordKey: sha256Base64Url(`${definition.dataType}\n${canonicalJson(identity)}`),
		...(googleDataPointName === undefined ? {} : { googleDataPointName }),
		dataType: definition.dataType,
		category: definition.category,
		recordTimestamp: normalizedTime.recordTimestamp,
		...(normalizedTime.startTime === undefined ? {} : { startTime: normalizedTime.startTime }),
		...(normalizedTime.endTime === undefined ? {} : { endTime: normalizedTime.endTime }),
		localDate: normalizedTime.localDate,
		...coverageMetadata(definition, payload, raw),
		...(primaryValue === undefined ? {} : { primaryValue }),
		primaryUnit: definition.primaryUnit,
		...sourceMetadata(definition, raw),
		...(sourceFamily === undefined ? {} : { sourceFamily }),
		...(googleCreateTime === undefined ? {} : { googleCreateTime: googleCreateTime.epochMs }),
		...(googleUpdateTime === undefined ? {} : { googleUpdateTime: googleUpdateTime.epochMs }),
		payloadDigest,
		payloadJson
	};
}
