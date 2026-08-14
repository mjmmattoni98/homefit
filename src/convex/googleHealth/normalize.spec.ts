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

	it('retains an own __proto__ field without mutating the canonical object prototype', () => {
		const value = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(value, '__proto__', {
			value: { polluted: true },
			enumerable: true
		});
		value.safe = 1;
		const changed = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(changed, '__proto__', {
			value: { polluted: false },
			enumerable: true
		});
		changed.safe = 1;

		expect(canonicalJson(value)).toBe('{"__proto__":{"polluted":true},"safe":1}');
		expect(canonicalJson(changed)).not.toBe(canonicalJson(value));
		expect(sha256Base64Url(canonicalJson(changed))).not.toBe(sha256Base64Url(canonicalJson(value)));
		expect({}).not.toHaveProperty('polluted');
	});
});

describe('Google Health point normalization', () => {
	it('normalizes a named reconciled sleep session with payload timestamps', () => {
		const point = normalizeGooglePoint(metric('sleep'), {
			dataPointName: 'users/health-user/dataTypes/sleep/dataPoints/sleep-1234',
			sleep: {
				interval: {
					startTime: '2026-08-14T22:30:00Z',
					startUtcOffset: '7200s',
					endTime: '2026-08-15T06:30:00Z',
					endUtcOffset: '7200s',
					civilStartTime: civilDateTime(2026, 8, 15, 0, 30),
					civilEndTime: civilDateTime(2026, 8, 15, 8, 30)
				},
				type: 'STAGES',
				createTime: '2026-08-15T06:31:00.123456789Z',
				updateTime: '2026-08-15T06:32:00.987654321Z'
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
			primaryUnit: 'min',
			sourceFamily: 'users/me/dataSourceFamilies/all-sources',
			googleCreateTime: Date.parse('2026-08-15T06:31:00.123456789Z'),
			googleUpdateTime: Date.parse('2026-08-15T06:32:00.987654321Z')
		});
		expect(point.recordKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(point.payloadJson).toContain('"type":"STAGES"');
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
				type: 'STAGES'
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

	it('defaults reconcile identity to all-sources while keeping explicit families distinct', () => {
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
		const defaultFamily = normalizeGooglePoint(metric('heart-rate'), raw);
		const named = {
			name: 'users/me/dataTypes/heart-rate/dataPoints/fixed-1234',
			...raw
		};

		expect(allSources.recordKey).not.toBe(wearable.recordKey);
		expect(defaultFamily.recordKey).toBe(allSources.recordKey);
		expect(defaultFamily.sourceFamily).toBe('users/me/dataSourceFamilies/all-sources');
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

	it('extracts safe list-source metadata without inventing a list source family', () => {
		const point = normalizeGooglePoint(metric('food'), {
			name: 'users/me/foods/atlantic-salmon',
			dataSource: {
				platform: 'HEALTH_CONNECT',
				recordingMethod: 'PASSIVELY_MEASURED',
				application: { packageName: 'com.example.nutrition' },
				device: { manufacturer: 'Example', displayName: 'Kitchen Scale' }
			},
			food: { displayName: 'Atlantic salmon' }
		});

		expect(point).not.toHaveProperty('sourceFamily');
		expect(point).toMatchObject({
			sourcePlatform: 'HEALTH_CONNECT',
			sourceApplication: 'com.example.nutrition',
			sourceDevice: 'Kitchen Scale',
			recordingMethod: 'PASSIVELY_MEASURED'
		});
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
			totalCalories: { kcalSum: 1850 }
		});

		expect(point).toMatchObject({
			recordTimestamp: Date.UTC(2026, 7, 14),
			startTime: Date.UTC(2026, 7, 14),
			endTime: Date.UTC(2026, 7, 15),
			localDate: '2026-08-14',
			primaryValue: 1850,
			primaryUnit: 'kcal',
			sourceFamily: 'users/me/dataSourceFamilies/all-sources'
		});
	});

	it('normalizes an unnamed reference without requiring a timestamp', () => {
		const point = normalizeGooglePoint(metric('food'), {
			name: 'users/me/dataTypes/food/dataPoints/atlantic-salmon',
			food: { displayName: 'Atlantic salmon' }
		});

		expect(point).toMatchObject({
			recordTimestamp: 0,
			localDate: '1970-01-01',
			dataType: 'food',
			category: 'nutrition'
		});
		expect(point).not.toHaveProperty('primaryValue');
		expect(() =>
			normalizeGooglePoint(metric('food'), {
				food: { displayName: 'Mutable display name is not identity' }
			})
		).toThrow(/resource name/);
	});

	it('uses registry-owned semantic fields in unnamed identity', () => {
		const base = {
			interval: {
				startTime: '2026-08-14T09:00:00Z',
				endTime: '2026-08-14T10:00:00Z'
			}
		};
		const walking = normalizeGooglePoint(metric('exercise'), {
			exercise: {
				...base,
				exerciseType: 'WALKING',
				displayName: 'Walking',
				createTime: '2026-08-14T10:01:00.123456789Z',
				updateTime: '2026-08-14T10:02:00.987654321Z'
			}
		});
		const running = normalizeGooglePoint(metric('exercise'), {
			exercise: { ...base, exerciseType: 'RUNNING', displayName: 'Running' }
		});
		const renamed = normalizeGooglePoint(metric('exercise'), {
			exercise: { ...base, exerciseType: 'WALKING', displayName: 'Morning walk' }
		});

		expect(walking.recordKey).not.toBe(running.recordKey);
		expect(renamed.recordKey).toBe(walking.recordKey);
		expect(renamed.payloadDigest).not.toBe(walking.payloadDigest);
		expect(walking.googleCreateTime).toBe(Date.parse('2026-08-14T10:01:00.123456789Z'));
		expect(walking.googleUpdateTime).toBe(Date.parse('2026-08-14T10:02:00.987654321Z'));
	});

	it('uses the registered active-zone subtype while excluding its mutable minutes', () => {
		const interval = {
			startTime: '2026-08-14T10:00:00Z',
			endTime: '2026-08-14T10:05:00Z'
		};
		const first = normalizeGooglePoint(metric('active-zone-minutes'), {
			activeZoneMinutes: { interval, heartRateZone: 'FAT_BURN', activeZoneMinutes: '5' }
		});
		const corrected = normalizeGooglePoint(metric('active-zone-minutes'), {
			activeZoneMinutes: { interval, heartRateZone: 'FAT_BURN', activeZoneMinutes: '6' }
		});
		const cardio = normalizeGooglePoint(metric('active-zone-minutes'), {
			activeZoneMinutes: { interval, heartRateZone: 'CARDIO', activeZoneMinutes: '5' }
		});

		expect(corrected.recordKey).toBe(first.recordKey);
		expect(corrected.payloadDigest).not.toBe(first.payloadDigest);
		expect(cardio.recordKey).not.toBe(first.recordKey);
	});

	it('uses the current heart-rate-zone type in time-in-zone identity', () => {
		const interval = {
			startTime: '2026-08-14T10:00:00Z',
			endTime: '2026-08-14T10:05:00Z'
		};
		const point = (heartRateZoneType: string) =>
			normalizeGooglePoint(metric('time-in-heart-rate-zone'), {
				timeInHeartRateZone: { interval, heartRateZoneType }
			});

		expect(point('LIGHT').recordKey).not.toBe(point('MODERATE').recordKey);
		expect(point('LIGHT')).not.toHaveProperty('primaryValue');
	});

	it.each([
		['activity-level', 'activityLevel', 'activityLevelType', 'LIGHTLY_ACTIVE', 'VERY_ACTIVE'],
		['sleep', 'sleep', 'type', 'CLASSIC', 'STAGES'],
		['vo2-max', 'vo2Max', 'measurementMethod', 'FITBIT_RUN', 'COOPER_TEST'],
		['core-body-temperature', 'coreBodyTemperature', 'id', 'sensor-a', 'sensor-b']
	])(
		'keeps %s semantic identity distinct using its registered field',
		(dataType, payloadField, identityField, firstValue, secondValue) => {
			const definition = metric(dataType);
			const time =
				definition.recordKind === 'sample'
					? { sampleTime: { physicalTime: '2026-08-14T10:00:00Z' } }
					: {
							interval: {
								startTime: '2026-08-14T10:00:00Z',
								endTime: '2026-08-14T10:05:00Z'
							}
						};
			const first = normalizeGooglePoint(definition, {
				[payloadField]: { ...time, [identityField]: firstValue }
			});
			const second = normalizeGooglePoint(definition, {
				[payloadField]: { ...time, [identityField]: secondValue }
			});

			expect(second.recordKey).not.toBe(first.recordKey);
		}
	);

	it('prefers physical time, civil date, UTC offset, then UTC date in their proper roles', () => {
		const withCivil = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: {
					physicalTime: '2026-08-14T23:30:00Z',
					utcOffset: '-18000s',
					civilTime: civilDateTime(2026, 8, 14, 18, 30)
				},
				weightGrams: 72_000
			}
		});
		const withOffset = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: {
					physicalTime: '2026-08-14T23:30:00Z',
					utcOffset: '7200s'
				},
				weightGrams: 72_000
			}
		});
		const utcOnly = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: { physicalTime: '2026-08-14T23:30:00Z' },
				weightGrams: 72_000
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
				weightGrams: 72_000
			}
		});
		const invalid = normalizeGooglePoint(metric('weight'), {
			weight: {
				sampleTime: {
					physicalTime: 'not-a-time',
					civilTime: civilDateTime(2026, 8, 14, 10, 5, 6)
				},
				weightGrams: 72_000
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

	it('uses exact registry-owned conversions and omits ambiguous nested values', () => {
		const sampleTime = { physicalTime: '2026-08-14T10:00:00Z' };
		const interval = {
			startTime: '2026-08-14T10:00:00Z',
			endTime: '2026-08-14T10:05:00Z'
		};
		const weight = normalizeGooglePoint(metric('weight'), {
			weight: { sampleTime, weightGrams: 72_500 }
		});
		const height = normalizeGooglePoint(metric('height'), {
			height: { sampleTime, heightMillimeters: '1750' }
		});
		const distance = normalizeGooglePoint(metric('distance'), {
			distance: { interval, millimeters: '12345' }
		});
		const altitude = normalizeGooglePoint(metric('altitude'), {
			altitude: { interval, gainMillimeters: '2500' }
		});
		const glucose = normalizeGooglePoint(metric('blood-glucose'), {
			bloodGlucose: { sampleTime, bloodGlucoseMilligramsPerDeciliter: 180.182 }
		});
		const zones = normalizeGooglePoint(metric('daily-heart-rate-zones'), {
			dailyHeartRateZones: {
				date: '2026-08-14',
				heartRateZones: [
					{ heartRateZoneType: 'FAT_BURN', minimumBeatsPerMinute: 90 },
					{ heartRateZoneType: 'CARDIO', minimumBeatsPerMinute: 120 }
				]
			}
		});
		const electrocardiogram = normalizeGooglePoint(metric('electrocardiogram'), {
			electrocardiogram: {
				interval: {
					startTime: '2026-08-14T10:00:00Z',
					endTime: '2026-08-14T10:00:00Z'
				},
				beatsPerMinuteAvg: '62',
				waveformSamples: [120, 125, 119],
				millivoltsScalingFactor: 1000
			}
		});

		expect(weight).toMatchObject({ primaryValue: 72.5, primaryUnit: 'kg' });
		expect(height).toMatchObject({ primaryValue: 1.75, primaryUnit: 'm' });
		expect(distance).toMatchObject({ primaryValue: 12.345, primaryUnit: 'm' });
		expect(altitude).toMatchObject({ primaryValue: 2.5, primaryUnit: 'm' });
		expect(glucose.primaryValue).toBeCloseTo(10, 10);
		expect(glucose.primaryUnit).toBe('mmol/L');
		expect(zones).not.toHaveProperty('primaryValue');
		expect(electrocardiogram).not.toHaveProperty('primaryValue');
	});

	it('chooses only explicitly registered values for multi-value metrics', () => {
		const temperature = normalizeGooglePoint(metric('daily-sleep-temperature-derivations'), {
			dailySleepTemperatureDerivations: {
				date: { year: 2026, month: 8, day: 14 },
				nightlyTemperatureCelsius: 36.4,
				baselineTemperatureCelsius: 36.7,
				relativeNightlyStddev30dCelsius: 0.2
			}
		});
		const respiratory = normalizeGooglePoint(metric('respiratory-rate-sleep-summary'), {
			respiratoryRateSleepSummary: {
				sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
				deepSleepStats: { breathsPerMinute: 12 },
				fullSleepStats: { breathsPerMinute: 15.5 }
			}
		});

		expect(temperature).toMatchObject({ primaryValue: 36.4, primaryUnit: '°C' });
		expect(respiratory).toMatchObject({ primaryValue: 15.5, primaryUnit: 'breaths/min' });
	});

	it('uses the current scalar fields for daily and zone metrics', () => {
		const interval = {
			startTime: '2026-08-14T10:00:00Z',
			endTime: '2026-08-14T10:05:00Z'
		};
		const date = { year: 2026, month: 8, day: 14 };
		const points = [
			normalizeGooglePoint(metric('active-zone-minutes'), {
				activeZoneMinutes: { interval, heartRateZone: 'LIGHT', activeZoneMinutes: 7 }
			}),
			normalizeGooglePoint(metric('daily-heart-rate-variability'), {
				dailyHeartRateVariability: {
					date,
					averageHeartRateVariabilityMilliseconds: 43
				}
			}),
			normalizeGooglePoint(metric('daily-oxygen-saturation'), {
				dailyOxygenSaturation: { date, averagePercentage: 96.5 }
			}),
			normalizeGooglePoint(metric('daily-respiratory-rate'), {
				dailyRespiratoryRate: { date, breathsPerMinute: 14.5 }
			}),
			normalizeGooglePoint(metric('daily-vo2-max'), {
				dailyVo2Max: { date, vo2Max: 47.5 }
			}),
			normalizeGooglePoint(metric('vo2-max'), {
				vo2Max: {
					sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
					measurementMethod: 'COOPER_TEST',
					vo2Max: 48.5
				}
			})
		];

		expect(points.map(({ primaryValue, primaryUnit }) => [primaryValue, primaryUnit])).toEqual([
			[7, 'min'],
			[43, 'ms'],
			[96.5, '%'],
			[14.5, 'breaths/min'],
			[47.5, 'mL/kg/min'],
			[48.5, 'mL/kg/min']
		]);
	});

	it('normalizes the current interval-shaped nutrition log', () => {
		const interval = {
			startTime: '2026-08-14T12:00:00Z',
			endTime: '2026-08-14T12:15:00Z'
		};
		const point = (food: string, mealType: string, kcal: number) =>
			normalizeGooglePoint(metric('nutrition-log'), {
				nutritionLog: {
					interval,
					food,
					mealType,
					foodDisplayName: 'Salad',
					energy: { kcal }
				}
			});
		const first = point('users/me/foods/salad', 'LUNCH', 450);
		const corrected = point('users/me/foods/salad', 'LUNCH', 475);
		const differentFood = point('users/me/foods/soup', 'LUNCH', 450);
		const differentMeal = point('users/me/foods/salad', 'DINNER', 450);
		const anonymous = (foodDisplayName: string) =>
			normalizeGooglePoint(metric('nutrition-log'), {
				nutritionLog: { interval, foodDisplayName, mealType: 'LUNCH', energy: { kcal: 450 } }
			});

		expect(first).toMatchObject({
			startTime: Date.parse('2026-08-14T12:00:00Z'),
			endTime: Date.parse('2026-08-14T12:15:00Z'),
			localDate: '2026-08-14',
			primaryValue: 450,
			primaryUnit: 'kcal'
		});
		expect(corrected.recordKey).toBe(first.recordKey);
		expect(corrected.payloadDigest).not.toBe(first.payloadDigest);
		expect(differentFood.recordKey).not.toBe(first.recordKey);
		expect(differentMeal.recordKey).not.toBe(first.recordKey);
		expect(anonymous('Salad').recordKey).not.toBe(anonymous('Soup').recordKey);
	});

	it('uses a core-temperature ID before mutable time and value fields', () => {
		const point = (id: string, physicalTime: string, temperatureCelsius: number) =>
			normalizeGooglePoint(metric('core-body-temperature'), {
				coreBodyTemperature: {
					id,
					sampleTime: { physicalTime },
					measurementLocation: 'WRIST',
					temperatureCelsius
				}
			});
		const first = point('temperature-abc', '2026-08-14T10:00:00Z', 36.5);
		const corrected = point('temperature-abc', '2026-08-14T10:01:00Z', 36.6);
		const other = point('temperature-def', '2026-08-14T10:00:00Z', 36.5);

		expect(corrected.recordKey).toBe(first.recordKey);
		expect(corrected.payloadDigest).not.toBe(first.payloadDigest);
		expect(other.recordKey).not.toBe(first.recordKey);
	});

	it('uses audited array, duration, nested quantity, and corrected-unit strategies', () => {
		const interval = {
			startTime: '2026-08-14T10:00:00Z',
			endTime: '2026-08-14T11:00:00Z'
		};
		const activeMinutes = normalizeGooglePoint(metric('active-minutes'), {
			activeMinutes: {
				interval,
				activeMinutesByActivityLevel: [
					{ activityLevel: 'LIGHT', activeMinutes: '10' },
					{ activityLevel: 'VIGOROUS', activeMinutes: '20' }
				]
			}
		});
		const calories = normalizeGooglePoint(metric('calories-in-heart-rate-zone'), {
			civilStartTime: civilDateTime(2026, 8, 14),
			civilEndTime: civilDateTime(2026, 8, 15),
			caloriesInHeartRateZone: {
				caloriesInHeartRateZones: [
					{ heartRateZone: 'LIGHT', kcal: 100 },
					{ heartRateZone: 'VIGOROUS', kcal: 225 }
				]
			}
		});
		const hydration = normalizeGooglePoint(metric('hydration-log'), {
			hydrationLog: { interval, amountConsumed: { milliliters: 750 } }
		});
		const exercise = normalizeGooglePoint(metric('exercise'), {
			exercise: { interval, exerciseType: 'WALKING', activeDuration: '3000s' }
		});
		const exerciseFallback = normalizeGooglePoint(metric('exercise'), {
			exercise: { interval, exerciseType: 'WALKING' }
		});
		const hrv = normalizeGooglePoint(metric('heart-rate-variability'), {
			heartRateVariability: {
				sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
				rootMeanSquareOfSuccessiveDifferencesMilliseconds: 42,
				standardDeviationMilliseconds: 55
			}
		});
		const runVo2 = normalizeGooglePoint(metric('run-vo2-max'), {
			runVo2Max: {
				sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
				runVo2Max: 48.5
			}
		});
		const swim = normalizeGooglePoint(metric('swim-lengths-data'), {
			swimLengthsData: { interval, swimStrokeType: 'FREESTYLE', strokeCount: '36' }
		});
		const sleep = normalizeGooglePoint(metric('sleep'), {
			sleep: { interval, type: 'STAGES', summary: { minutesAsleep: 52 } }
		});

		expect(activeMinutes).toMatchObject({ primaryValue: 30, primaryUnit: 'min' });
		expect(calories).toMatchObject({ primaryValue: 325, primaryUnit: 'kcal' });
		expect(hydration).toMatchObject({ primaryValue: 750, primaryUnit: 'mL' });
		expect(exercise).toMatchObject({ primaryValue: 50, primaryUnit: 'min' });
		expect(exerciseFallback).toMatchObject({ primaryValue: 60, primaryUnit: 'min' });
		expect(hrv).toMatchObject({ primaryValue: 42, primaryUnit: 'ms' });
		expect(runVo2).toMatchObject({ primaryValue: 48.5, primaryUnit: 'mL/kg/min' });
		expect(swim).toMatchObject({ primaryValue: 36, primaryUnit: 'strokes' });
		expect(sleep).toMatchObject({ primaryValue: 52, primaryUnit: 'min' });
	});

	it('omits an aggregate primary value when any required member is malformed', () => {
		const point = normalizeGooglePoint(metric('active-minutes'), {
			activeMinutes: {
				interval: {
					startTime: '2026-08-14T10:00:00Z',
					endTime: '2026-08-14T11:00:00Z'
				},
				activeMinutesByActivityLevel: [
					{ activityLevel: 'LIGHT', activeMinutes: '10' },
					{ activityLevel: 'VIGOROUS', activeMinutes: 'invalid' }
				]
			}
		});

		expect(point).not.toHaveProperty('primaryValue');
	});

	it('uses stable external IDs before interval identity when the registry provides one', () => {
		const sleep = (externalId: string, startHour: string) =>
			normalizeGooglePoint(metric('sleep'), {
				sleep: {
					interval: {
						startTime: `2026-08-14T${startHour}:00:00Z`,
						endTime: `2026-08-14T${String(Number(startHour) + 1).padStart(2, '0')}:00:00Z`
					},
					type: 'STAGES',
					metadata: { externalId }
				}
			});
		const first = sleep('sleep-abc', '08');
		const correctedBounds = sleep('sleep-abc', '09');
		const other = sleep('sleep-def', '08');

		expect(correctedBounds.recordKey).toBe(first.recordKey);
		expect(correctedBounds.payloadDigest).not.toBe(first.payloadDigest);
		expect(other.recordKey).not.toBe(first.recordKey);
	});

	it('includes both daily-rollup civil bounds in unnamed identity', () => {
		const point = (startDay: number, endDay: number) =>
			normalizeGooglePoint(metric('total-calories'), {
				civilStartTime: civilDateTime(2026, 8, startDay),
				civilEndTime: civilDateTime(2026, 8, endDay),
				totalCalories: { kcalSum: 100 }
			});

		expect(point(14, 15).recordKey).not.toBe(point(14, 16).recordKey);
		expect(point(14, 15).recordKey).not.toBe(point(13, 15).recordKey);
		expect(() =>
			normalizeGooglePoint(metric('total-calories'), {
				civilStartTime: civilDateTime(2026, 8, 14),
				totalCalories: { kcalSum: 100 }
			})
		).toThrow(/civil end time/);
	});

	it('preserves RFC3339 nanoseconds in identity and rejects non-RFC3339 physical times', () => {
		const at = (physicalTime: string) =>
			normalizeGooglePoint(metric('heart-rate'), {
				heartRate: { sampleTime: { physicalTime }, beatsPerMinute: 61 }
			});
		const first = at('2026-08-14T10:00:00.123456789Z');
		const second = at('2026-08-14T10:00:00.123999999Z');

		expect(first.recordTimestamp).toBe(second.recordTimestamp);
		expect(first.recordKey).not.toBe(second.recordKey);
		expect(() => at('2026-08-14T10:00:00')).toThrow(/usable time/);
		expect(() => at('2026-02-30T10:00:00Z')).toThrow(/usable time/);
		expect(() => at('9999-12-31T23:59:59-23:59')).toThrow(/usable time/);
	});

	it('rejects reversed time intervals', () => {
		expect(() =>
			normalizeGooglePoint(metric('exercise'), {
				exercise: {
					interval: {
						startTime: '2026-08-14T11:00:00Z',
						endTime: '2026-08-14T10:00:00Z'
					},
					exerciseType: 'WALKING'
				}
			})
		).toThrow(/end precedes start/);
	});

	it('accepts exactly 750 KiB of UTF-8 payload JSON and rejects one byte more', () => {
		const wrapperBytes = new TextEncoder().encode(
			'{"food":{"displayName":""},"name":"users/me/dataTypes/food/dataPoints/test-food"}'
		).byteLength;
		const availableBytes = MAX_PAYLOAD_BYTES - wrapperBytes;
		const exactDisplayName = `${'é'.repeat(Math.floor(availableBytes / 2))}${
			availableBytes % 2 === 0 ? '' : 'x'
		}`;
		const exact = normalizeGooglePoint(metric('food'), {
			name: 'users/me/dataTypes/food/dataPoints/test-food',
			food: { displayName: exactDisplayName }
		});

		expect(new TextEncoder().encode(exact.payloadJson).byteLength).toBe(MAX_PAYLOAD_BYTES);
		expect(() =>
			normalizeGooglePoint(metric('food'), {
				name: 'users/me/dataTypes/food/dataPoints/test-food',
				food: { displayName: `${exactDisplayName}x` }
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
