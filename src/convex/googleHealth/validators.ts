import { type Infer, v } from 'convex/values';

export const connectionStatusValidator = v.union(
	v.literal('connecting'),
	v.literal('backfilling'),
	v.literal('active'),
	v.literal('delayed'),
	v.literal('action_required'),
	v.literal('disconnected'),
	v.literal('deleting')
);

export const healthCategoryValidator = v.union(
	v.literal('activity'),
	v.literal('vitals'),
	v.literal('sleep'),
	v.literal('body'),
	v.literal('nutrition'),
	v.literal('other')
);

export const syncModeValidator = v.union(v.literal('backfill'), v.literal('incremental'));

export const syncTriggerValidator = v.union(
	v.literal('oauth'),
	v.literal('webhook'),
	v.literal('manual'),
	v.literal('retry'),
	v.literal('reconciliation')
);

export const normalizedHealthPointValidator = v.object({
	provider: v.literal('google_health'),
	recordKey: v.string(),
	googleDataPointName: v.optional(v.string()),
	dataType: v.string(),
	category: healthCategoryValidator,
	recordTimestamp: v.number(),
	startTime: v.optional(v.number()),
	endTime: v.optional(v.number()),
	localDate: v.string(),
	physicalCoverageTime: v.optional(v.number()),
	civilCoverageTime: v.optional(v.string()),
	primaryValue: v.optional(v.number()),
	primaryUnit: v.optional(v.string()),
	sourcePlatform: v.optional(v.string()),
	sourceApplication: v.optional(v.string()),
	sourceDevice: v.optional(v.string()),
	recordingMethod: v.optional(v.string()),
	sourceFamily: v.optional(v.string()),
	googleCreateTime: v.optional(v.number()),
	googleUpdateTime: v.optional(v.number()),
	payloadDigest: v.string(),
	payloadJson: v.string()
});

export type ConnectionStatus = Infer<typeof connectionStatusValidator>;
export type HealthCategory = Infer<typeof healthCategoryValidator>;
export type SyncMode = Infer<typeof syncModeValidator>;
export type SyncTrigger = Infer<typeof syncTriggerValidator>;
export type NormalizedHealthPoint = Infer<typeof normalizedHealthPointValidator>;
