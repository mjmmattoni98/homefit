import * as m from '$lib/paraglide/messages';

const metricLabels: Readonly<Record<string, () => string>> = {
	'active-energy-burned': m.google_health_metric_active_energy_burned,
	'active-minutes': m.google_health_metric_active_minutes,
	'active-zone-minutes': m.google_health_metric_active_zone_minutes,
	'activity-level': m.google_health_metric_activity_level,
	altitude: m.google_health_metric_altitude,
	'basal-energy-burned': m.google_health_metric_basal_energy_burned,
	'blood-glucose': m.google_health_metric_blood_glucose,
	'body-fat': m.google_health_metric_body_fat,
	'calories-in-heart-rate-zone': m.google_health_metric_calories_in_heart_rate_zone,
	'core-body-temperature': m.google_health_metric_core_body_temperature,
	'daily-heart-rate-variability': m.google_health_metric_daily_heart_rate_variability,
	'daily-heart-rate-zones': m.google_health_metric_daily_heart_rate_zones,
	'daily-oxygen-saturation': m.google_health_metric_daily_oxygen_saturation,
	'daily-respiratory-rate': m.google_health_metric_daily_respiratory_rate,
	'daily-resting-heart-rate': m.google_health_metric_daily_resting_heart_rate,
	'daily-sleep-temperature-derivations': m.google_health_metric_daily_sleep_temperature_derivations,
	'daily-vo2-max': m.google_health_metric_daily_vo2_max,
	distance: m.google_health_metric_distance,
	electrocardiogram: m.google_health_metric_electrocardiogram,
	exercise: m.google_health_metric_exercise,
	floors: m.google_health_metric_floors,
	food: m.google_health_metric_food,
	'food-measurement-unit': m.google_health_metric_food_measurement_unit,
	'heart-rate': m.google_health_metric_heart_rate,
	'heart-rate-variability': m.google_health_metric_heart_rate_variability,
	height: m.google_health_metric_height,
	'hydration-log': m.google_health_metric_hydration_log,
	'irregular-rhythm-notification': m.google_health_metric_irregular_rhythm_notification,
	'nutrition-log': m.google_health_metric_nutrition_log,
	'oxygen-saturation': m.google_health_metric_oxygen_saturation,
	'respiratory-rate-sleep-summary': m.google_health_metric_respiratory_rate_sleep_summary,
	'run-vo2-max': m.google_health_metric_run_vo2_max,
	'sedentary-period': m.google_health_metric_sedentary_period,
	sleep: m.google_health_metric_sleep,
	steps: m.google_health_metric_steps,
	'swim-lengths-data': m.google_health_metric_swim_lengths_data,
	'time-in-heart-rate-zone': m.google_health_metric_time_in_heart_rate_zone,
	'total-calories': m.google_health_metric_total_calories,
	'vo2-max': m.google_health_metric_vo2_max,
	weight: m.google_health_metric_weight
};

const categoryLabels = {
	activity: m.google_health_category_activity,
	vitals: m.google_health_category_vitals,
	sleep: m.google_health_category_sleep,
	body: m.google_health_category_body_measurements,
	nutrition: m.google_health_category_nutrition,
	other: m.google_health_category_other
} as const;

export type HealthCategory = keyof typeof categoryLabels;

export function metricLabel(dataType: string): string {
	const localized = metricLabels[dataType];
	if (localized !== undefined) return localized();
	const words = dataType
		.split('-')
		.filter(Boolean)
		.map((word) => `${word.slice(0, 1).toLocaleUpperCase()}${word.slice(1)}`);
	return words.length > 0 ? words.join(' ') : m.google_health_unknown_metric();
}

export function categoryLabel(category: HealthCategory): string {
	return categoryLabels[category]();
}
