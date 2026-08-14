import type { HealthCategory } from './validators';

const GOOGLE_HEALTH_SCOPE_BASE = 'https://www.googleapis.com/auth/googlehealth.';

const READ_SCOPE_SUFFIXES = [
	'activity_and_fitness',
	'ecg',
	'health_metrics_and_measurements',
	'irn',
	'location',
	'nutrition',
	'sleep'
] as const;

export const GOOGLE_HEALTH_READ_SCOPES: readonly string[] = Object.freeze(
	READ_SCOPE_SUFFIXES.map((scopeSuffix) => `${GOOGLE_HEALTH_SCOPE_BASE}${scopeSuffix}.readonly`)
);

export type MetricRecordKind = 'sample' | 'interval' | 'daily' | 'session' | 'reference';
export type MetricReadMode = 'list' | 'reconcile' | 'rollUp' | 'dailyRollUp';
export type MetricAggregation = 'sum' | 'average' | 'latest' | 'duration';

export type MetricPrimaryValueStrategy =
	| {
			readonly kind: 'direct';
			readonly path: readonly string[];
			readonly multiplier: number;
	  }
	| {
			readonly kind: 'sum';
			readonly arrayPath: readonly string[];
			readonly valuePath: readonly string[];
			readonly multiplier: number;
	  }
	| {
			readonly kind: 'duration';
			readonly path: readonly string[];
			readonly secondsMultiplier: number;
			readonly intervalFallback: boolean;
	  };

export interface MetricDefinition {
	readonly dataType: string;
	readonly payloadField: string;
	readonly recordKind: MetricRecordKind;
	readonly category: HealthCategory;
	readonly scope: string;
	readonly readMode: MetricReadMode;
	readonly webhook: boolean;
	readonly aggregation: MetricAggregation;
	readonly primaryUnit: string;
	readonly identityPaths: readonly (readonly string[])[];
	readonly identityReferencePath?: readonly string[];
	readonly primaryValueStrategy?: MetricPrimaryValueStrategy;
	readonly payloadLifecycleTimestamps: boolean;
	readonly maxWindowDays?: number;
}

type ScopeSuffix = Exclude<(typeof READ_SCOPE_SUFFIXES)[number], 'location'>;
type RawMetricDefinition = readonly [
	dataType: string,
	payloadField: string,
	recordKind: MetricRecordKind,
	category: HealthCategory,
	scopeSuffix: ScopeSuffix,
	readMode: MetricReadMode,
	webhook: boolean,
	aggregation: MetricAggregation,
	primaryUnit: string
];

// Keep the API contract auditable against Google's data-type table.
// prettier-ignore
const definitions = [
	['active-energy-burned', 'activeEnergyBurned', 'interval', 'activity', 'activity_and_fitness', 'reconcile', false, 'sum', 'kcal'],
	['active-minutes', 'activeMinutes', 'interval', 'activity', 'activity_and_fitness', 'reconcile', false, 'sum', 'min'],
	['active-zone-minutes', 'activeZoneMinutes', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'sum', 'min'],
	['activity-level', 'activityLevel', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'duration', ''],
	['altitude', 'altitude', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'average', 'm'],
	['blood-glucose', 'bloodGlucose', 'sample', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'average', 'mmol/L'],
	['body-fat', 'bodyFat', 'sample', 'body', 'health_metrics_and_measurements', 'reconcile', true, 'average', '%'],
	['calories-in-heart-rate-zone', 'caloriesInHeartRateZone', 'daily', 'activity', 'activity_and_fitness', 'dailyRollUp', true, 'sum', 'kcal'],
	['core-body-temperature', 'coreBodyTemperature', 'sample', 'vitals', 'health_metrics_and_measurements', 'reconcile', false, 'average', '°C'],
	['daily-heart-rate-variability', 'dailyHeartRateVariability', 'daily', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'latest', 'ms'],
	['daily-heart-rate-zones', 'dailyHeartRateZones', 'daily', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'latest', ''],
	['daily-oxygen-saturation', 'dailyOxygenSaturation', 'daily', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'average', '%'],
	['daily-respiratory-rate', 'dailyRespiratoryRate', 'daily', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'average', 'breaths/min'],
	['daily-resting-heart-rate', 'dailyRestingHeartRate', 'daily', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'latest', 'bpm'],
	['daily-sleep-temperature-derivations', 'dailySleepTemperatureDerivations', 'daily', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'latest', '°C'],
	['daily-vo2-max', 'dailyVo2Max', 'daily', 'activity', 'activity_and_fitness', 'reconcile', false, 'latest', 'mL/kg/min'],
	['distance', 'distance', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'sum', 'm'],
	['electrocardiogram', 'electrocardiogram', 'session', 'vitals', 'ecg', 'list', false, 'latest', ''],
	['exercise', 'exercise', 'session', 'activity', 'activity_and_fitness', 'reconcile', true, 'duration', 'min'],
	['floors', 'floors', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'sum', 'floors'],
	['food', 'food', 'reference', 'nutrition', 'nutrition', 'list', false, 'latest', ''],
	['food-measurement-unit', 'foodMeasurementUnit', 'reference', 'nutrition', 'nutrition', 'list', false, 'latest', ''],
	['heart-rate', 'heartRate', 'sample', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'average', 'bpm'],
	['heart-rate-variability', 'heartRateVariability', 'sample', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'average', 'ms'],
	['height', 'height', 'sample', 'body', 'health_metrics_and_measurements', 'reconcile', true, 'latest', 'm'],
	['hydration-log', 'hydrationLog', 'session', 'nutrition', 'nutrition', 'reconcile', true, 'sum', 'mL'],
	['irregular-rhythm-notification', 'irregularRhythmNotification', 'session', 'vitals', 'irn', 'list', false, 'latest', ''],
	['nutrition-log', 'nutritionLog', 'session', 'nutrition', 'nutrition', 'reconcile', true, 'sum', 'kcal'],
	['oxygen-saturation', 'oxygenSaturation', 'sample', 'vitals', 'health_metrics_and_measurements', 'reconcile', false, 'average', '%'],
	['respiratory-rate-sleep-summary', 'respiratoryRateSleepSummary', 'sample', 'vitals', 'health_metrics_and_measurements', 'reconcile', true, 'average', 'breaths/min'],
	['run-vo2-max', 'runVo2Max', 'sample', 'activity', 'activity_and_fitness', 'reconcile', true, 'latest', 'mL/kg/min'],
	['sedentary-period', 'sedentaryPeriod', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'duration', ''],
	['sleep', 'sleep', 'session', 'sleep', 'sleep', 'reconcile', true, 'duration', 'min'],
	['steps', 'steps', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'sum', 'steps'],
	['swim-lengths-data', 'swimLengthsData', 'interval', 'activity', 'activity_and_fitness', 'reconcile', false, 'sum', 'strokes'],
	['time-in-heart-rate-zone', 'timeInHeartRateZone', 'interval', 'activity', 'activity_and_fitness', 'reconcile', true, 'duration', ''],
	['total-calories', 'totalCalories', 'daily', 'activity', 'activity_and_fitness', 'dailyRollUp', false, 'sum', 'kcal'],
	['vo2-max', 'vo2Max', 'sample', 'activity', 'activity_and_fitness', 'reconcile', false, 'latest', 'mL/kg/min'],
	['weight', 'weight', 'sample', 'body', 'health_metrics_and_measurements', 'reconcile', true, 'latest', 'kg'],
] as const satisfies readonly RawMetricDefinition[];

const IDENTITY_PATHS_BY_DATA_TYPE: Readonly<
	Partial<Record<string, readonly (readonly string[])[]>>
> = {
	'active-zone-minutes': [['heartRateZone']],
	'activity-level': [['activityLevelType']],
	'blood-glucose': [['measurementSource'], ['mealType'], ['measurementTiming'], ['specimen']],
	'core-body-temperature': [['id'], ['measurementLocation']],
	exercise: [['exerciseType']],
	'nutrition-log': [['food'], ['foodDisplayName'], ['mealType']],
	sleep: [['type']],
	'swim-lengths-data': [['swimStrokeType']],
	'time-in-heart-rate-zone': [['heartRateZoneType']],
	'vo2-max': [['measurementMethod']]
};

const IDENTITY_REFERENCE_PATHS: Readonly<Partial<Record<string, readonly string[]>>> = {
	'core-body-temperature': ['id'],
	sleep: ['metadata', 'externalId']
};

const PRIMARY_VALUE_STRATEGIES: Readonly<
	Partial<
		Record<
			string,
			| { readonly kind?: 'direct'; readonly path: readonly string[]; readonly multiplier?: number }
			| {
					readonly kind: 'sum';
					readonly arrayPath: readonly string[];
					readonly valuePath: readonly string[];
					readonly multiplier?: number;
			  }
			| {
					readonly kind: 'duration';
					readonly path: readonly string[];
					readonly secondsMultiplier: number;
					readonly intervalFallback: boolean;
			  }
		>
	>
> = {
	'active-energy-burned': { path: ['kcal'] },
	'active-minutes': {
		kind: 'sum',
		arrayPath: ['activeMinutesByActivityLevel'],
		valuePath: ['activeMinutes']
	},
	'active-zone-minutes': { path: ['activeZoneMinutes'] },
	altitude: { path: ['gainMillimeters'], multiplier: 0.001 },
	'blood-glucose': {
		path: ['bloodGlucoseMilligramsPerDeciliter'],
		multiplier: 1 / 18.0182
	},
	'body-fat': { path: ['percentage'] },
	'core-body-temperature': { path: ['temperatureCelsius'] },
	'daily-heart-rate-variability': { path: ['averageHeartRateVariabilityMilliseconds'] },
	'daily-oxygen-saturation': { path: ['averagePercentage'] },
	'daily-respiratory-rate': { path: ['breathsPerMinute'] },
	'daily-resting-heart-rate': { path: ['beatsPerMinute'] },
	'daily-sleep-temperature-derivations': { path: ['nightlyTemperatureCelsius'] },
	'daily-vo2-max': { path: ['vo2Max'] },
	distance: { path: ['millimeters'], multiplier: 0.001 },
	exercise: {
		kind: 'duration',
		path: ['activeDuration'],
		secondsMultiplier: 1 / 60,
		intervalFallback: true
	},
	floors: { path: ['count'] },
	'heart-rate': { path: ['beatsPerMinute'] },
	'heart-rate-variability': {
		path: ['rootMeanSquareOfSuccessiveDifferencesMilliseconds']
	},
	height: { path: ['heightMillimeters'], multiplier: 0.001 },
	'hydration-log': { path: ['amountConsumed', 'milliliters'] },
	'nutrition-log': { path: ['energy', 'kcal'] },
	'oxygen-saturation': { path: ['percentage'] },
	'respiratory-rate-sleep-summary': { path: ['fullSleepStats', 'breathsPerMinute'] },
	'run-vo2-max': { path: ['runVo2Max'] },
	sleep: { path: ['summary', 'minutesAsleep'] },
	steps: { path: ['count'] },
	'swim-lengths-data': { path: ['strokeCount'] },
	'total-calories': { path: ['kcalSum'] },
	'vo2-max': { path: ['vo2Max'] },
	weight: { path: ['weightGrams'], multiplier: 0.001 },
	'calories-in-heart-rate-zone': {
		kind: 'sum',
		arrayPath: ['caloriesInHeartRateZones'],
		valuePath: ['kcal']
	}
};

function freezePaths(
	paths: readonly (readonly string[])[] | undefined
): readonly (readonly string[])[] {
	return Object.freeze((paths ?? []).map((path) => Object.freeze([...path])));
}

function getPrimaryValueStrategy(dataType: string): MetricPrimaryValueStrategy | undefined {
	const strategy = PRIMARY_VALUE_STRATEGIES[dataType];
	if (strategy === undefined) return undefined;
	if (strategy.kind === 'sum') {
		return Object.freeze({
			kind: 'sum',
			arrayPath: Object.freeze([...strategy.arrayPath]),
			valuePath: Object.freeze([...strategy.valuePath]),
			multiplier: strategy.multiplier ?? 1
		});
	}
	if (strategy.kind === 'duration') {
		return Object.freeze({
			kind: 'duration',
			path: Object.freeze([...strategy.path]),
			secondsMultiplier: strategy.secondsMultiplier,
			intervalFallback: strategy.intervalFallback
		});
	}
	return Object.freeze({
		kind: 'direct',
		path: Object.freeze([...strategy.path]),
		multiplier: strategy.multiplier ?? 1
	});
}

function getMaxWindowDays(readMode: MetricReadMode): number | undefined {
	if (readMode === 'dailyRollUp') {
		return 14;
	}

	if (readMode === 'rollUp') {
		return 90;
	}

	return undefined;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = Object.freeze(
	definitions.map(
		([
			dataType,
			payloadField,
			recordKind,
			category,
			scopeSuffix,
			readMode,
			webhook,
			aggregation,
			primaryUnit
		]) => {
			const maxWindowDays = getMaxWindowDays(readMode);
			const primaryValueStrategy = getPrimaryValueStrategy(dataType);
			const identityReferencePath = IDENTITY_REFERENCE_PATHS[dataType];

			return Object.freeze({
				dataType,
				payloadField,
				recordKind,
				category,
				scope: `${GOOGLE_HEALTH_SCOPE_BASE}${scopeSuffix}.readonly`,
				readMode,
				webhook,
				aggregation,
				primaryUnit,
				identityPaths: freezePaths(IDENTITY_PATHS_BY_DATA_TYPE[dataType]),
				payloadLifecycleTimestamps: dataType === 'exercise' || dataType === 'sleep',
				...(identityReferencePath === undefined
					? {}
					: { identityReferencePath: Object.freeze([...identityReferencePath]) }),
				...(primaryValueStrategy === undefined ? {} : { primaryValueStrategy }),
				...(maxWindowDays === undefined ? {} : { maxWindowDays })
			});
		}
	)
);

const metricDefinitionsByDataType = new Map(
	METRIC_DEFINITIONS.map((definition) => [definition.dataType, definition] as const)
);

export function getMetricDefinition(dataType: string): MetricDefinition | null {
	return metricDefinitionsByDataType.get(dataType) ?? null;
}
