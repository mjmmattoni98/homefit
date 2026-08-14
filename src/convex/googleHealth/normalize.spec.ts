import { describe, expect, it } from 'vitest';
import { getMetricDefinition, type MetricDefinition } from './registry';
import { canonicalJson, normalizeGooglePoint, sha256Base64Url } from './normalize';

const MAX_PAYLOAD_BYTES = 750 * 1024;

function metric(dataType: string): MetricDefinition {
	const definition = getMetricDefinition(dataType);
	if (definition === null) {
		throw new Error(`Missing test metric definition: ${dataType}`);
	}
	return definition;
}

function civilDateTime(
	year: number,
	month: number,
	day: number,
	hours = 0,
	minutes = 0,
	seconds = 0
) {
	return {
		date: { year, month, day },
		time: { hours, minutes, seconds }
	};
}

describe('canonical Google Health JSON', () => {
	it('sorts object keys recursively without changing array order', () => {
		expect(canonicalJson({ z: [3, { b: true, a: null }], a: 'é' })).toBe(
			'{"a":"é","z":[3,{"a":null,"b":true}]}'
		);
	});

	it.each([
		['', '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU'],
		['abc', 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'],
		[
			'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
			'JI1qYdIGOLjlwCaTDD5gOaM85Flk_yFn9uzt1BnbBsE'
		],
		['é', 'SplVfkAzw1Od4utlRyAXytX5VX96BiWgnxw_biumnEw']
	])('produces a standard SHA-256 base64url digest for %j', (value, digest) => {
		expect(sha256Base64Url(value)).toBe(digest);
	});

	it('allows a repeated reference that is not a cycle', () => {
		const child = { value: 1 };
		expect(canonicalJson({ second: child, first: child })).toBe(
			'{"first":{"value":1},"second":{"value":1}}'
		);
	});

	it.each([
		['undefined', undefined],
		['bigint', 1n],
		['function', () => 1],
		['symbol', Symbol('value')],
		['NaN', Number.NaN],
		['infinity', Number.POSITIVE_INFINITY],
		['a date object', new Date('2026-08-14T00:00:00Z')],
		['an undefined property', { value: undefined }],
		['an array hole', Array(1)]
	])('rejects unsupported JSON value: %s', (_label, value) => {
		expect(() => canonicalJson(value)).toThrow(/plain JSON-compatible/);
	});

	it('rejects cyclic input', () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
	});
});

describe('Google Health point normalization', () => {
	it('normalizes a named sleep session and safe list-source metadata', () => {
		const point = normalizeGooglePoint(metric('sleep'), {
			name: 'users/health-user/dataTypes/sleep/dataPoints/sleep-1234',
			createTime: '2026-08-15T06:31:00Z',
			updateTime: '2026-08-15T06:32:00Z',
			dataSource: {
				platform: 'HEALTH_CONNECT',
				recordingMethod: 'PASSIVELY_MEASURED',
				application: { packageName: 'com.example.sleep' },
				device: {
					formFactor: 'WATCH',
					manufacturer: 'Example',
					displayName: 'Dream Watch'
				}
			},
			sleep: {
				interval: {
					startTime: '2026-08-14T22:30:00Z',
					startUtcOffset: '7200s',
					endTime: '2026-08-15T06:30:00Z',
					endUtcOffset: '7200s',
					civilStartTime: civilDateTime(2026, 8, 15, 0, 30),
					civilEndTime: civilDateTime(2026, 8, 15, 8, 30)
				},
				sleepType: 'MAIN_SLEEP'
			}
		});

		expect(point).toMatchObject({
			provider: 'google_health',
			googleDataPointName: 'users/health-user/dataTypes/sleep/dataPoints/sleep-1234',
			dataType: 'sleep',
			category: 'sleep',
			recordTimestamp: Date.parse('2026-08-14T22:30:00Z'),
			startTime: Date.parse('2026-08-14T22:30:00Z'),
			endTime: Date.parse('2026-08-15T06:30:00Z'),
			localDate: '2026-08-15',
			primaryUnit: '',
			sourcePlatform: 'HEALTH_CONNECT',
			sourceApplication: 'com.example.sleep',
			sourceDevice: 'Dream Watch',
			recordingMethod: 'PASSIVELY_MEASURED',
			googleCreateTime: Date.parse('2026-08-15T06:31:00Z'),
			googleUpdateTime: Date.parse('2026-08-15T06:32:00Z')
		});
		expect(point.recordKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(point.payloadJson).toContain('"packageName":"com.example.sleep"');
	});

	it('keeps an unnamed sample key stable across measurement corrections', () => {
		const first = normalizeGooglePoint(
			metric('heart-rate'),
			{
				heartRate: {
					sampleTime: {
						physicalTime: '2026-08-14T10:00:00Z',
						utcOffset: '7200s',
						civilTime: civilDateTime(2026, 8, 14, 12)
					},
					beatsPerMinute: '61'
				}
			},
			{ sourceFamily: 'users/me/dataSourceFamilies/google-wearables' }
		);
		const corrected = normalizeGooglePoint(
			metric('heart-rate'),
			{
				heartRate: {
					sampleTime: {
						physicalTime: '2026-08-14T10:00:00Z',
						utcOffset: '7200s',
						civilTime: civilDateTime(2026, 8, 14, 12)
					},
					beatsPerMinute: '63'
				}
			},
			{ sourceFamily: 'users/me/dataSourceFamilies/google-wearables' }
		);

		expect(first).toMatchObject({
			recordTimestamp: Date.parse('2026-08-14T10:00:00Z'),
			localDate: '2026-08-14',
			primaryValue: 61,
			primaryUnit: 'bpm',
			sourceFamily: 'users/me/dataSourceFamilies/google-wearables'
		});
		expect(corrected.recordKey).toBe(first.recordKey);
		expect(corrected.payloadDigest).not.toBe(first.payloadDigest);
		expect(corrected.primaryValue).toBe(63);
	});

	it('accepts the reconcile response dataPointName as named identity', () => {
		const raw = {
			dataPointName: 'users/me/dataTypes/sleep/dataPoints/reconciled-1234',
			sleep: {
				interval: {
					startTime: '2026-08-14T22:30:00Z',
					endTime: '2026-08-15T06:30:00Z'
				},
				sleepType: 'MAIN_SLEEP'
			}
		};
		const first = normalizeGooglePoint(metric('sleep'), raw, {
			sourceFamily: 'users/me/dataSourceFamilies/google-sources'
		});
		const corrected = normalizeGooglePoint(
			metric('sleep'),
			{
				...raw,
				sleep: { ...raw.sleep, score: 90 }
			},
			{ sourceFamily: 'users/me/dataSourceFamilies/google-wearables' }
		);

		expect(first.googleDataPointName).toBe(raw.dataPointName);
		expect(corrected.recordKey).toBe(first.recordKey);
		expect(corrected.payloadDigest).not.toBe(first.payloadDigest);
	});

	it('uses source family only for unnamed identity while always exposing it when supplied', () => {
		const raw = {
			heartRate: {
				sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
				beatsPerMinute: 61
			}
		};
		const allSources = normalizeGooglePoint(metric('heart-rate'), raw, {
			sourceFamily: 'users/me/dataSourceFamilies/all-sources'
		});
		const wearable = normalizeGooglePoint(metric('heart-rate'), raw, {
			sourceFamily: 'users/me/dataSourceFamilies/google-wearables'
		});
		const noFamily = normalizeGooglePoint(metric('heart-rate'), raw);
		const named = {
			name: 'users/me/dataTypes/heart-rate/dataPoints/fixed-1234',
			...raw
		};

		expect(allSources.recordKey).not.toBe(wearable.recordKey);
		expect(noFamily.recordKey).not.toBe(allSources.recordKey);
		expect(noFamily).not.toHaveProperty('sourceFamily');
		expect(
			normalizeGooglePoint(metric('heart-rate'), named, {
				sourceFamily: 'users/me/dataSourceFamilies/all-sources'
			}).recordKey
		).toBe(
			normalizeGooglePoint(metric('heart-rate'), named, {
				sourceFamily: 'users/me/dataSourceFamilies/google-wearables'
			}).recordKey
		);
		expect(
			normalizeGooglePoint(metric('heart-rate'), named, {
				sourceFamily: 'users/me/dataSourceFamilies/all-sources'
			})
		).toHaveProperty('sourceFamily', 'users/me/dataSourceFamilies/all-sources');
	});

	it('normalizes an unnamed interval', () => {
		const point = normalizeGooglePoint(metric('steps'), {
			steps: {
				interval: {
					startTime: '2026-08-14T08:00:00Z',
					endTime: '2026-08-14T08:15:00Z',
					startUtcOffset: '7200s',
					endUtcOffset: '7200s'
				},
				count: '1200'
			}
		});

		expect(point).toMatchObject({
			recordTimestamp: Date.parse('2026-08-14T08:00:00Z'),
			startTime: Date.parse('2026-08-14T08:00:00Z'),
			endTime: Date.parse('2026-08-14T08:15:00Z'),
			localDate: '2026-08-14',
			primaryValue: 1200,
			primaryUnit: 'steps'
		});
	});

	it('normalizes a daily record', () => {
		const point = normalizeGooglePoint(metric('daily-resting-heart-rate'), {
			dailyRestingHeartRate: {
				date: { year: 2026, month: 8, day: 14 },
				beatsPerMinute: 54
			}
		});

		expect(point).toMatchObject({
			recordTimestamp: Date.UTC(2026, 7, 14),
			localDate: '2026-08-14',
			primaryValue: 54,
			primaryUnit: 'bpm'
		});
	});

	it('normalizes a daily-rollup record from root civil bounds', () => {
		const point = normalizeGooglePoint(metric('total-calories'), {
			civilStartTime: civilDateTime(2026, 8, 14),
			civilEndTime: civilDateTime(2026, 8, 15),
			totalCalories: { caloriesSum: 1850 }
		});

		expect(point).toMatchObject({
			recordTimestamp: Date.UTC(2026, 7, 14),
			startTime: Date.UTC(2026, 7, 14),
			endTime: Date.UTC(2026, 7, 15),
			localDate: '2026-08-14',
			primaryValue: 1850,
			primaryUnit: 'kcal'
		});
	});

	it('normalizes an unnamed reference without requiring a timestamp', () => {
		const point = normalizeGooglePoint(metric('food'), {
			food: { name: 'foods/atlantic-salmon', displayName: 'Atlantic salmon' }
		});

		expect(point).toMatchObject({
			recordTimestamp: 0,
			localDate: '1970-01-01',
			dataType: 'food',
			category: 'nutrition'
		});
		expect(point).not.toHaveProperty('primaryValue');
	});

	it('uses semantic subtype fields in unnamed identity', () => {
		const base = {
			interval: {
				startTime: '2026-08-14T09:00:00Z',
				endTime: '2026-08-14T10:00:00Z'
			}
		};
		const walking = normalizeGooglePoint(metric('exercise'), {
			exercise: { ...base, exerciseType: 'WALKING', title: 'Morning outing' }
		});
		const running = normalizeGooglePoint(metric('exercise'), {
			exercise: { ...base, exerciseType: 'RUNNING', title: 'Morning outing' }
		});
		const renamed = normalizeGooglePoint(metric('exercise'), {
			exercise: { ...base, exerciseType: 'WALKING', title: 'Renamed outing' }
		});

		expect(walking.recordKey).not.toBe(running.recordKey);
		expect(renamed.recordKey).toBe(walking.recordKey);
		expect(renamed.payloadDigest).not.toBe(walking.payloadDigest);
	});

	it('prefers physical time, civil date, UTC offset, then UTC date in their proper roles', () => {
		const withCivil = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: {
					physicalTime: '2026-08-14T23:30:00Z',
					utcOffset: '-18000s',
					civilTime: civilDateTime(2026, 8, 14, 18, 30)
				},
				kilograms: 72
			}
		});
		const withOffset = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: {
					physicalTime: '2026-08-14T23:30:00Z',
					utcOffset: '7200s'
				},
				kilograms: 72
			}
		});
		const utcOnly = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: { physicalTime: '2026-08-14T23:30:00Z' },
				kilograms: 72
			}
		});

		expect(withCivil.recordTimestamp).toBe(Date.parse('2026-08-14T23:30:00Z'));
		expect(withCivil.localDate).toBe('2026-08-14');
		expect(withOffset.localDate).toBe('2026-08-15');
		expect(utcOnly.localDate).toBe('2026-08-14');
	});

	it('falls back from absent or invalid physical time to civil time', () => {
		const absent = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: { civilTime: civilDateTime(2026, 8, 14, 10, 5, 6) },
				kilograms: 72
			}
		});
		const invalid = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: {
					physicalTime: 'not-a-time',
					civilTime: civilDateTime(2026, 8, 14, 10, 5, 6)
				},
				kilograms: 72
			}
		});

		expect(absent.recordTimestamp).toBe(Date.UTC(2026, 7, 14, 10, 5, 6));
		expect(invalid.recordTimestamp).toBe(absent.recordTimestamp);
		expect(absent.localDate).toBe('2026-08-14');
	});

	it('canonicalizes equivalent payloads deterministically', () => {
		const first = normalizeGooglePoint(metric('heart-rate'), {
			heartRate: {
				beatsPerMinute: 61,
				sampleTime: { utcOffset: '0s', physicalTime: '2026-08-14T10:00:00Z' }
			}
		});
		const second = normalizeGooglePoint(metric('heart-rate'), {
			heartRate: {
				sampleTime: { physicalTime: '2026-08-14T10:00:00Z', utcOffset: '0s' },
				beatsPerMinute: 61
			}
		});

		expect(second.payloadJson).toBe(first.payloadJson);
		expect(second.payloadDigest).toBe(first.payloadDigest);
		expect(second.recordKey).toBe(first.recordKey);
	});

	it('selects numeric strings recursively by documented scalar preference', () => {
		const preferred = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
				score: 99,
				meters: 1.75,
				kilograms: '72.5'
			}
		});
		const nested = normalizeGooglePoint(metric('daily-heart-rate-zones'), {
			dailyHeartRateZones: {
				date: '2026-08-14',
				value: 4,
				nested: { count: '9' }
			}
		});

		expect(preferred.primaryValue).toBe(72.5);
		expect(nested.primaryValue).toBe(9);
	});

	it('accepts exactly 750 KiB of UTF-8 payload JSON and rejects one byte more', () => {
		const wrapperBytes = new TextEncoder().encode('{"food":{"name":""}}').byteLength;
		const exact = normalizeGooglePoint(metric('food'), {
			food: { name: 'x'.repeat(MAX_PAYLOAD_BYTES - wrapperBytes) }
		});

		expect(new TextEncoder().encode(exact.payloadJson).byteLength).toBe(MAX_PAYLOAD_BYTES);
		expect(() =>
			normalizeGooglePoint(metric('food'), {
				food: { name: 'x'.repeat(MAX_PAYLOAD_BYTES - wrapperBytes + 1) }
			})
		).toThrow(/750 KiB/);
	});

	it('rejects a non-object payload, missing metric payload, and unusable time', () => {
		expect(() => normalizeGooglePoint(metric('heart-rate'), null)).toThrow(/plain object/);
		expect(() => normalizeGooglePoint(metric('heart-rate'), {})).toThrow(/heartRate/);
		expect(() =>
			normalizeGooglePoint(metric('heart-rate'), {
				heartRate: { sampleTime: { physicalTime: 'not-a-time' }, beatsPerMinute: 61 }
			})
		).toThrow(/usable time/);
	});
});
