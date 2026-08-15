import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	connectionStatusValidator,
	healthCategoryValidator,
	normalizedHealthPointValidator,
	syncModeValidator,
	syncTriggerValidator
} from './googleHealth/validators';

export default defineSchema({
	sleepRecords: defineTable({
		userId: v.string(),
		wentToBed: v.number(), // epoch ms
		wokeUp: v.number(), // epoch ms
		sleepQuality: v.number(), // 0-100
		timeInBedSeconds: v.number(),
		timeAsleepSeconds: v.number(),
		asleepAfterSeconds: v.number(),
		regularity: v.optional(v.number()), // 0-100
		didSnore: v.boolean(),
		snoreTimeSeconds: v.number(),
		steps: v.optional(v.number()),
		weatherTempC: v.optional(v.number()),
		weatherType: v.optional(v.string()),
		city: v.optional(v.string()),
		movementsPerHour: v.optional(v.number()),
		notes: v.array(v.string()),
		mood: v.optional(v.string())
	}).index('by_user_and_wokeUp', ['userId', 'wokeUp']),

	workouts: defineTable({
		userId: v.string(),
		title: v.string(),
		startTime: v.number(), // epoch ms
		endTime: v.number(), // epoch ms
		description: v.optional(v.string())
	}).index('by_user_and_startTime', ['userId', 'startTime']),

	workoutSets: defineTable({
		workoutId: v.id('workouts'),
		userId: v.string(),
		// Denormalized from the parent workout so exercise history queries can
		// order by session date directly through the index.
		startTime: v.number(), // epoch ms
		exerciseTitle: v.string(),
		setIndex: v.number(),
		setType: v.string(),
		weightKg: v.optional(v.number()),
		reps: v.optional(v.number()),
		distanceKm: v.optional(v.number()),
		durationSeconds: v.optional(v.number()),
		rpe: v.optional(v.number()),
		supersetId: v.optional(v.string()),
		exerciseNotes: v.optional(v.string())
	})
		.index('by_workout', ['workoutId'])
		.index('by_user_and_exercise_and_startTime', ['userId', 'exerciseTitle', 'startTime']),

	googleHealthOAuthStates: defineTable({
		userId: v.string(),
		stateDigest: v.string(),
		expiresAt: v.number(),
		returnPath: v.string(),
		consumedAt: v.optional(v.number())
	})
		.index('by_stateDigest', ['stateDigest'])
		.index('by_expiresAt', ['expiresAt'])
		.index('by_userId', ['userId']),

	googleHealthConnections: defineTable({
		userId: v.string(),
		healthUserId: v.optional(v.string()),
		status: connectionStatusValidator,
		encryptedRefreshToken: v.optional(v.string()),
		tokenNonce: v.optional(v.string()),
		tokenTag: v.optional(v.string()),
		tokenKeyVersion: v.optional(v.string()),
		grantedScopes: v.array(v.string()),
		generation: v.number(),
		reconciliationEpoch: v.optional(v.number()),
		backfillTotalTypes: v.number(),
		backfillCompletedTypes: v.number(),
		lastAttemptAt: v.optional(v.number()),
		lastSuccessfulSyncAt: v.optional(v.number()),
		lastErrorCode: v.optional(v.string()),
		lastErrorMessage: v.optional(v.string()),
		nextRetryAt: v.optional(v.number()),
		disconnectedAt: v.optional(v.number())
	})
		.index('by_userId', ['userId'])
		.index('by_healthUserId', ['healthUserId'])
		.index('by_status', ['status']),

	googleHealthSyncCursors: defineTable({
		connectionId: v.id('googleHealthConnections'),
		userId: v.string(),
		dataType: v.string(),
		mode: syncModeValidator,
		status: v.union(
			v.literal('queued'),
			v.literal('running'),
			v.literal('complete'),
			v.literal('retry')
		),
		pageToken: v.optional(v.string()),
		windowStart: v.optional(v.string()),
		windowEnd: v.optional(v.string()),
		watermark: v.optional(v.string()),
		syncId: v.string(),
		attempt: v.number(),
		generation: v.number(),
		activeRunId: v.optional(v.id('googleHealthSyncRuns')),
		leaseExpiresAt: v.optional(v.number()),
		reconciliationEpoch: v.optional(v.number()),
		activeEpoch: v.optional(v.number()),
		updatedAt: v.number()
	})
		.index('by_connectionId_and_dataType_and_mode', ['connectionId', 'dataType', 'mode'])
		.index('by_userId', ['userId'])
		.index('by_status_and_updatedAt', ['status', 'updatedAt']),

	healthDataPoints: defineTable({
		connectionId: v.id('googleHealthConnections'),
		userId: v.string(),
		...normalizedHealthPointValidator.fields,
		lastSeenSyncId: v.string(),
		seenEpoch: v.optional(v.number())
	})
		.index('by_userId_and_recordKey', ['userId', 'recordKey'])
		.index('by_userId_and_dataType_and_recordTimestamp', ['userId', 'dataType', 'recordTimestamp'])
		.index('by_userId_and_dataType_and_localDate', ['userId', 'dataType', 'localDate'])
		.index('by_userId_and_dataType_and_localDate_and_recordTimestamp', [
			'userId',
			'dataType',
			'localDate',
			'recordTimestamp'
		])
		.index('by_userId_and_category_and_recordTimestamp', ['userId', 'category', 'recordTimestamp'])
		.index('by_connectionId', ['connectionId'])
		.index('by_connectionId_and_dataType_and_physicalCoverageTime', [
			'connectionId',
			'dataType',
			'physicalCoverageTime'
		])
		.index('by_connectionId_and_dataType_and_civilCoverageTime', [
			'connectionId',
			'dataType',
			'civilCoverageTime'
		]),

	healthDataPointContributions: defineTable({
		connectionId: v.id('googleHealthConnections'),
		dataPointId: v.id('healthDataPoints'),
		userId: v.string(),
		recordKey: v.string(),
		dataType: v.string(),
		category: healthCategoryValidator,
		localDate: v.string(),
		recordTimestamp: v.number(),
		primaryValue: v.optional(v.number()),
		durationSeconds: v.optional(v.number()),
		physicalCoverageTime: v.optional(v.number()),
		civilCoverageTime: v.optional(v.string()),
		seenEpoch: v.number()
	})
		.index('by_userId_and_recordKey', ['userId', 'recordKey'])
		.index('by_userId_and_dataType_and_localDate', ['userId', 'dataType', 'localDate'])
		.index('by_connectionId_and_dataType_and_physicalCoverageTime', [
			'connectionId',
			'dataType',
			'physicalCoverageTime'
		])
		.index('by_connectionId_and_dataType_and_civilCoverageTime', [
			'connectionId',
			'dataType',
			'civilCoverageTime'
		]),

	healthSummaryRebuilds: defineTable({
		connectionId: v.id('googleHealthConnections'),
		userId: v.string(),
		dataType: v.string(),
		category: healthCategoryValidator,
		localDate: v.string(),
		version: v.number(),
		status: v.union(v.literal('queued'), v.literal('running'), v.literal('complete')),
		paginationCursor: v.optional(v.string()),
		count: v.number(),
		valueCount: v.number(),
		sum: v.number(),
		min: v.optional(v.number()),
		max: v.optional(v.number()),
		latestValue: v.optional(v.number()),
		latestTimestamp: v.optional(v.number()),
		durationSeconds: v.number(),
		updatedAt: v.number()
	})
		.index('by_userId_and_dataType_and_localDate', ['userId', 'dataType', 'localDate'])
		.index('by_status_and_updatedAt', ['status', 'updatedAt']),

	healthDailySummaries: defineTable({
		connectionId: v.id('googleHealthConnections'),
		userId: v.string(),
		dataType: v.string(),
		category: healthCategoryValidator,
		localDate: v.string(),
		count: v.number(),
		latestValue: v.optional(v.number()),
		latestTimestamp: v.optional(v.number()),
		sum: v.optional(v.number()),
		average: v.optional(v.number()),
		min: v.optional(v.number()),
		max: v.optional(v.number()),
		durationSeconds: v.optional(v.number()),
		computedAt: v.number()
	})
		.index('by_userId_and_dataType_and_localDate', ['userId', 'dataType', 'localDate'])
		.index('by_userId_and_category_and_localDate', ['userId', 'category', 'localDate'])
		.index('by_connectionId', ['connectionId']),

	googleHealthSyncRuns: defineTable({
		connectionId: v.id('googleHealthConnections'),
		userId: v.string(),
		trigger: syncTriggerValidator,
		dataType: v.string(),
		cursorId: v.optional(v.id('googleHealthSyncCursors')),
		generation: v.optional(v.number()),
		reconciliationEpoch: v.optional(v.number()),
		rangeStart: v.optional(v.string()),
		rangeEnd: v.optional(v.string()),
		startedAt: v.number(),
		finishedAt: v.optional(v.number()),
		pages: v.number(),
		fetched: v.number(),
		inserted: v.number(),
		updated: v.number(),
		deleted: v.number(),
		skipped: v.number(),
		status: v.union(v.literal('running'), v.literal('succeeded'), v.literal('failed')),
		errorCode: v.optional(v.string()),
		errorMessage: v.optional(v.string())
	})
		.index('by_connectionId_and_startedAt', ['connectionId', 'startedAt'])
		.index('by_userId_and_startedAt', ['userId', 'startedAt'])
		.index('by_status_and_startedAt', ['status', 'startedAt'])
});
