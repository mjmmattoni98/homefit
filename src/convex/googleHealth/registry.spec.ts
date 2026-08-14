import { describe, expect, it } from 'vitest';
import { GOOGLE_HEALTH_READ_SCOPES, METRIC_DEFINITIONS, getMetricDefinition } from './registry';

const EXPECTED_DEFINITION_ROWS = [
	'active-energy-burned|activeEnergyBurned|interval|activity|activity_and_fitness|reconcile|false|sum|kcal',
	'active-minutes|activeMinutes|interval|activity|activity_and_fitness|reconcile|false|sum|min',
	'active-zone-minutes|activeZoneMinutes|interval|activity|activity_and_fitness|reconcile|true|sum|min',
	'activity-level|activityLevel|interval|activity|activity_and_fitness|reconcile|true|duration|',
	'altitude|altitude|interval|activity|activity_and_fitness|reconcile|true|sum|m',
	'basal-energy-burned|basalEnergyBurned|interval|activity|activity_and_fitness|reconcile|false|sum|kcal',
	'blood-glucose|bloodGlucose|sample|vitals|health_metrics_and_measurements|reconcile|true|average|mmol/L',
	'body-fat|bodyFat|sample|body|health_metrics_and_measurements|reconcile|true|average|%',
	'calories-in-heart-rate-zone|caloriesInHeartRateZone|daily|activity|activity_and_fitness|dailyRollUp|true|sum|kcal',
	'core-body-temperature|coreBodyTemperature|sample|vitals|health_metrics_and_measurements|reconcile|false|average|°C',
	'daily-heart-rate-variability|dailyHeartRateVariability|daily|vitals|health_metrics_and_measurements|reconcile|true|latest|ms',
	'daily-heart-rate-zones|dailyHeartRateZones|daily|vitals|health_metrics_and_measurements|reconcile|true|latest|',
	'daily-oxygen-saturation|dailyOxygenSaturation|daily|vitals|health_metrics_and_measurements|reconcile|true|average|%',
	'daily-respiratory-rate|dailyRespiratoryRate|daily|vitals|health_metrics_and_measurements|reconcile|true|average|breaths/min',
	'daily-resting-heart-rate|dailyRestingHeartRate|daily|vitals|health_metrics_and_measurements|reconcile|true|latest|bpm',
	'daily-sleep-temperature-derivations|dailySleepTemperatureDerivations|daily|vitals|health_metrics_and_measurements|reconcile|true|latest|°C',
	'daily-vo2-max|dailyVo2Max|daily|activity|activity_and_fitness|reconcile|false|latest|mL/kg/min',
	'distance|distance|interval|activity|activity_and_fitness|reconcile|true|sum|m',
	'electrocardiogram|electrocardiogram|session|vitals|ecg|list|false|latest|',
	'exercise|exercise|session|activity|activity_and_fitness|reconcile|true|duration|min',
	'floors|floors|interval|activity|activity_and_fitness|reconcile|true|sum|floors',
	'food|food|reference|nutrition|nutrition|list|false|latest|',
	'food-measurement-unit|foodMeasurementUnit|reference|nutrition|nutrition|list|false|latest|',
	'heart-rate|heartRate|sample|vitals|health_metrics_and_measurements|reconcile|true|average|bpm',
	'heart-rate-variability|heartRateVariability|sample|vitals|health_metrics_and_measurements|reconcile|true|average|ms',
	'height|height|sample|body|health_metrics_and_measurements|reconcile|true|latest|m',
	'hydration-log|hydrationLog|session|nutrition|nutrition|reconcile|true|sum|mL',
	'irregular-rhythm-notification|irregularRhythmNotification|session|vitals|irn|list|false|latest|',
	'nutrition-log|nutritionLog|session|nutrition|nutrition|reconcile|true|sum|kcal',
	'oxygen-saturation|oxygenSaturation|sample|vitals|health_metrics_and_measurements|reconcile|false|average|%',
	'respiratory-rate-sleep-summary|respiratoryRateSleepSummary|sample|vitals|health_metrics_and_measurements|reconcile|true|average|breaths/min',
	'run-vo2-max|runVo2Max|sample|activity|activity_and_fitness|reconcile|true|latest|mL/kg/min',
	'sedentary-period|sedentaryPeriod|interval|activity|activity_and_fitness|reconcile|true|duration|',
	'sleep|sleep|session|sleep|sleep|reconcile|true|duration|min',
	'steps|steps|interval|activity|activity_and_fitness|reconcile|true|sum|steps',
	'swim-lengths-data|swimLengthsData|interval|activity|activity_and_fitness|reconcile|false|sum|strokes',
	'time-in-heart-rate-zone|timeInHeartRateZone|interval|activity|activity_and_fitness|reconcile|true|duration|',
	'total-calories|totalCalories|daily|activity|activity_and_fitness|dailyRollUp|false|sum|kcal',
	'vo2-max|vo2Max|sample|activity|activity_and_fitness|reconcile|false|latest|mL/kg/min',
	'weight|weight|sample|body|health_metrics_and_measurements|reconcile|true|latest|kg'
] as const;

const EXPECTED_SCOPES = [
	'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
	'https://www.googleapis.com/auth/googlehealth.ecg.readonly',
	'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
	'https://www.googleapis.com/auth/googlehealth.irn.readonly',
	'https://www.googleapis.com/auth/googlehealth.location.readonly',
	'https://www.googleapis.com/auth/googlehealth.nutrition.readonly',
	'https://www.googleapis.com/auth/googlehealth.sleep.readonly'
] as const;

const EXPECTED_WEBHOOK_TYPES = [
	'active-zone-minutes',
	'activity-level',
	'altitude',
	'blood-glucose',
	'body-fat',
	'calories-in-heart-rate-zone',
	'daily-heart-rate-variability',
	'daily-heart-rate-zones',
	'daily-oxygen-saturation',
	'daily-respiratory-rate',
	'daily-resting-heart-rate',
	'daily-sleep-temperature-derivations',
	'distance',
	'exercise',
	'floors',
	'heart-rate',
	'heart-rate-variability',
	'height',
	'hydration-log',
	'nutrition-log',
	'respiratory-rate-sleep-summary',
	'run-vo2-max',
	'sedentary-period',
	'sleep',
	'steps',
	'time-in-heart-rate-zone',
	'weight'
] as const;

function serializeDefinition(definition: (typeof METRIC_DEFINITIONS)[number]): string {
	return [
		definition.dataType,
		definition.payloadField,
		definition.recordKind,
		definition.category,
		definition.scope
			.replace('https://www.googleapis.com/auth/googlehealth.', '')
			.replace('.readonly', ''),
		definition.readMode,
		definition.webhook,
		definition.aggregation,
		definition.primaryUnit
	].join('|');
}

describe('Google Health metric registry', () => {
	it('defines exactly the 40 readable data types with unique kebab-case identifiers', () => {
		const dataTypes = METRIC_DEFINITIONS.map((definition) => definition.dataType);

		expect(dataTypes).toHaveLength(40);
		expect(new Set(dataTypes).size).toBe(40);
		expect(dataTypes.every((dataType) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dataType))).toBe(true);
		expect(dataTypes).toEqual(
			EXPECTED_DEFINITION_ROWS.map((definition) => definition.split('|')[0])
		);
		expect(dataTypes).not.toEqual(
			expect.arrayContaining(['menstrual-period', 'moods', 'ovulation-test', 'symptoms'])
		);
	});

	it('preserves every endpoint, payload, display, aggregation, and unit classification', () => {
		expect(METRIC_DEFINITIONS.map(serializeDefinition)).toEqual(EXPECTED_DEFINITION_ROWS);
	});

	it('owns exact source-unit conversion and semantic identity metadata', () => {
		expect(getMetricDefinition('weight')).toMatchObject({
			primaryValueStrategy: { path: ['weightGrams'], multiplier: 0.001 },
			identityStrategy: { components: [] }
		});
		expect(getMetricDefinition('height')).toMatchObject({
			primaryValueStrategy: { path: ['heightMillimeters'], multiplier: 0.001 }
		});
		expect(getMetricDefinition('distance')).toMatchObject({
			primaryValueStrategy: { path: ['millimeters'], multiplier: 0.001 }
		});
		expect(getMetricDefinition('altitude')).toMatchObject({
			primaryValueStrategy: { path: ['gainMillimeters'], multiplier: 0.001 }
		});
		expect(getMetricDefinition('basal-energy-burned')).toMatchObject({
			aggregation: 'sum',
			primaryUnit: 'kcal',
			primaryValueStrategy: { path: ['kcal'], multiplier: 1 }
		});
		expect(getMetricDefinition('blood-glucose')).toMatchObject({
			primaryValueStrategy: {
				path: ['bloodGlucoseMilligramsPerDeciliter'],
				multiplier: 1 / 18.0182
			}
		});
		expect(getMetricDefinition('activity-level')?.identityStrategy.components).toEqual([
			{ kind: 'value', path: ['activityLevelType'] }
		]);
		expect(getMetricDefinition('active-zone-minutes')?.identityStrategy.components).toEqual([
			{ kind: 'value', path: ['heartRateZone'] }
		]);
		expect(getMetricDefinition('sleep')?.identityStrategy).toEqual({
			components: [{ kind: 'value', path: ['type'] }]
		});
		expect(getMetricDefinition('exercise')?.identityStrategy.components).toEqual([
			{ kind: 'value', path: ['exerciseType'] }
		]);
		expect(getMetricDefinition('vo2-max')?.identityStrategy.components).toEqual([
			{ kind: 'value', path: ['measurementMethod'] }
		]);
		expect(getMetricDefinition('nutrition-log')?.identityStrategy).toEqual({
			components: [
				{ kind: 'firstPresent', paths: [['food'], ['foodDisplayName']] },
				{ kind: 'value', path: ['mealType'] }
			]
		});
		expect(getMetricDefinition('time-in-heart-rate-zone')?.identityStrategy.components).toEqual([
			{ kind: 'value', path: ['heartRateZoneType'] }
		]);
		expect(getMetricDefinition('core-body-temperature')?.identityStrategy).toEqual({
			components: [
				{ kind: 'value', path: ['id'] },
				{ kind: 'value', path: ['measurementLocation'] }
			],
			stableReferencePath: ['id']
		});
		expect(getMetricDefinition('sleep')?.payloadLifecycleTimestamps).toBe(true);
		expect(getMetricDefinition('exercise')?.payloadLifecycleTimestamps).toBe(true);
		expect(getMetricDefinition('heart-rate')?.payloadLifecycleTimestamps).toBe(false);
	});

	it('does not configure arbitrary scalar extraction for complex metric payloads', () => {
		expect(getMetricDefinition('daily-heart-rate-zones')?.primaryValueStrategy).toBeUndefined();
		expect(getMetricDefinition('time-in-heart-rate-zone')?.primaryValueStrategy).toBeUndefined();
		expect(getMetricDefinition('electrocardiogram')?.primaryValueStrategy).toBeUndefined();
		expect(getMetricDefinition('food')?.primaryValueStrategy).toBeUndefined();
		expect(
			METRIC_DEFINITIONS.every(
				(definition) =>
					definition.primaryUnit.length > 0 === (definition.primaryValueStrategy !== undefined)
			)
		).toBe(true);
	});

	it('requests exactly the seven approved read-only scopes', () => {
		expect(GOOGLE_HEALTH_READ_SCOPES).toEqual(EXPECTED_SCOPES);
		expect(new Set(METRIC_DEFINITIONS.map((definition) => definition.scope))).toEqual(
			new Set(EXPECTED_SCOPES.filter((scope) => !scope.includes('.location.')))
		);
		expect(GOOGLE_HEALTH_READ_SCOPES.every((scope) => scope.endsWith('.readonly'))).toBe(true);
	});

	it('marks exactly the 27 webhook-capable readable types', () => {
		const webhookTypes = METRIC_DEFINITIONS.filter((definition) => definition.webhook).map(
			(definition) => definition.dataType
		);

		expect(webhookTypes).toHaveLength(27);
		expect(webhookTypes).toEqual(EXPECTED_WEBHOOK_TYPES);
	});

	it('uses 14-day windows for the two daily-rollup data types', () => {
		const rollups = METRIC_DEFINITIONS.filter(
			(definition) => definition.readMode === 'dailyRollUp'
		);

		expect(rollups.map((definition) => definition.dataType)).toEqual([
			'calories-in-heart-rate-zone',
			'total-calories'
		]);
		expect(rollups.every((definition) => definition.maxWindowDays === 14)).toBe(true);
		expect(
			METRIC_DEFINITIONS.filter((definition) => definition.readMode !== 'dailyRollUp').every(
				(definition) => definition.maxWindowDays === undefined
			)
		).toBe(true);
	});

	it('returns immutable definitions by exact data-type lookup', () => {
		const steps = METRIC_DEFINITIONS.find((definition) => definition.dataType === 'steps');

		expect(Object.isFrozen(GOOGLE_HEALTH_READ_SCOPES)).toBe(true);
		expect(Object.isFrozen(METRIC_DEFINITIONS)).toBe(true);
		expect(METRIC_DEFINITIONS.every(Object.isFrozen)).toBe(true);
		expect(getMetricDefinition('steps')).toBe(steps);
		expect(getMetricDefinition('Steps')).toBeNull();
		expect(getMetricDefinition('unknown-type')).toBeNull();
	});
});
