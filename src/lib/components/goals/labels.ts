import type { DayStatus, GoalUnit, HistoryDay } from '#lib/daily-goals.js';
import * as m from '#lib/paraglide/messages.js';

/** Short unit after a number: "min", "reps", "s". */
export function unitLabel(unit: GoalUnit): string {
	if (unit === 'minutes') return m.goals_unit_minutes();
	if (unit === 'seconds') return m.goals_unit_seconds();
	return m.goals_unit_reps();
}

/** The unit on its own, for choosing one. */
export function unitName(unit: GoalUnit): string {
	if (unit === 'minutes') return m.goals_unit_name_minutes();
	if (unit === 'seconds') return m.goals_unit_name_seconds();
	return m.goals_unit_name_reps();
}

export function statusLabel(status: DayStatus): string {
	if (status === 'done') return m.goals_status_done();
	if (status === 'missed') return m.goals_status_missed();
	if (status === 'in-progress') return m.goals_status_in_progress();
	return m.goals_status_rest();
}

export function historyDayLabel(day: HistoryDay): string {
	return day.status === 'rest' && day.allMet ? m.goals_status_rest_met() : statusLabel(day.status);
}
