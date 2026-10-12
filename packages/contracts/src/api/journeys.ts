import { z } from "zod";

import {
	PUBLIC_SUITE_CASES_ORIGIN_VALUES,
	PUBLIC_SUITE_SCHEDULES_CADENCE_VALUES,
	PUBLIC_SUITES_LIFECYCLE_STATUS_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import {
	caseRepeatSchema,
	caseResultSchema,
	caseRoleSchema,
	caseRunVerdictSchema,
	clientIntentBodySchema,
	expectedRevisionSchema,
	idSchema,
	journeyCheckpointSchema,
	journeyParamsSchema,
	journeyStepSchema,
	mutableJourneyCaseSchema,
	nullableTimestampSchema,
	projectParamsSchema,
	suiteRunFinalizationSchema,
	suiteRunStatusSchema,
	suiteRunTriggerSchema,
	suiteRunVerdictSchema,
	timestampSchema,
} from "./primitives.ts";

export const scheduleSchema = z.object({
	cadence: z.enum(PUBLIC_SUITE_SCHEDULES_CADENCE_VALUES),
	localTime: z.string().nullable(),
	cronExpression: z.string().nullable(),
	timezone: z.string().nullable(),
	nextRunAt: nullableTimestampSchema,
	lastSkippedAt: nullableTimestampSchema,
	lastSkipReason: z.string().nullable(),
});

export const journeyCaseSchema = z.object({
	id: idSchema,
	title: z.string(),
	steps: z.array(journeyStepSchema),
	category: z.string(),
	checkpoints: z.array(journeyCheckpointSchema),
	whyItMatters: z.string().nullable(),
	preconditions: z.array(z.string()),
	/** A Journey, or a setup/teardown hook around the run. */
	role: caseRoleSchema,
	/** The Journey a before_each/after_each hook is appended to; null means every Journey. */
	scopeCaseId: idSchema.nullable(),
	repeat: caseRepeatSchema,
	/** Who wrote it: manual is the owner, the rest ShipBash. */
	origin: z.enum(PUBLIC_SUITE_CASES_ORIGIN_VALUES),
	enabled: z.boolean(),
	archived: z.boolean(),
	position: z.number().int().nonnegative(),
	latestVerdict: caseRunVerdictSchema.nullable(),
	latestRunAt: nullableTimestampSchema,
	verificationState: z.enum(["verified", "unverified"]),
	recentResults: z.array(caseResultSchema),
});

export const journeySummarySchema = z.object({
	id: idSchema,
	name: z.string(),
	caseCount: z.number().int().nonnegative(),
	enabledCaseCount: z.number().int().nonnegative(),
	definitionRevision: z.number().int().positive(),
	lifecycleStatus: z.enum(PUBLIC_SUITES_LIFECYCLE_STATUS_VALUES),
	productThesis: z.string().nullable(),
	latestVerdict: suiteRunVerdictSchema.nullable(),
	latestRunAt: nullableTimestampSchema,
	updatedAt: timestampSchema,
	schedule: scheduleSchema.nullable(),
});

export const journeyDetailSchema = journeySummarySchema.extend({
	cases: z.array(journeyCaseSchema),
});

export const runViewSchema = z.object({
	id: idSchema,
	isPublic: z.boolean(),
	suiteId: idSchema.nullable(),
	suiteName: z.string().nullable(),
	status: suiteRunStatusSchema,
	verdict: suiteRunVerdictSchema.nullable(),
	progressLabel: z.string(),
	triggerKind: suiteRunTriggerSchema.nullable(),
	updatedAt: timestampSchema,
});

export const runDispatchSchema = z.object({
	run: z.object({
		id: idSchema,
		teamId: idSchema,
		projectId: idSchema,
		suiteId: idSchema.nullable(),
		snapshotId: idSchema,
		status: suiteRunStatusSchema,
		verdict: suiteRunVerdictSchema.nullable(),
		finalizationStatus: suiteRunFinalizationSchema,
		triggerKind: suiteRunTriggerSchema.nullable(),
		createdAt: timestampSchema,
		startedAt: nullableTimestampSchema,
		completedAt: nullableTimestampSchema,
	}),
	snapshotId: idSchema,
	dispatchJobId: idSchema,
	created: z.boolean(),
	reusedOutstanding: z.boolean(),
});

const journeyResponseSchema = z.object({ suite: journeyDetailSchema });
const dispatchedRunResponseSchema = z.object({
	run: runViewSchema.extend({
		/**
		 * The run whose page shows this walk: the dispatched run itself, or —
		 * when it is a retry of one Journey — the run it is an attempt of.
		 */
		rootRunId: idSchema,
	}),
	dispatch: runDispatchSchema,
});

const journeyCaseParamsSchema = journeyParamsSchema.extend({
	caseId: idSchema,
});
/**
 * A hook written directly, against the Suite revision the caller read. It
 * names no category: the server derives it from the hook's slot.
 */
const journeyCaseWriteSchema = mutableJourneyCaseSchema
	.omit({ category: true })
	.extend({ expectedRevision: expectedRevisionSchema });
/** A hook added directly names its role; a Journey is refused, since a walk adds one. */
const addJourneyCaseSchema = journeyCaseWriteSchema.extend({ role: caseRoleSchema });
const retryCaseParamsSchema = projectParamsSchema.extend({
	runId: idSchema,
	caseRunId: idSchema,
});

export const getJourneyContract = defineApiContract({
	id: "journeys.get",
	method: "GET",
	path: "/api/projects/:projectId/journeys/:journeyId",
	params: journeyParamsSchema,
	query: null,
	body: null,
	response: journeyDetailSchema,
	successStatuses: [200],
});

export const addJourneyCaseContract = defineApiContract({
	id: "journeys.cases.create",
	method: "POST",
	path: "/api/projects/:projectId/journeys/:journeyId/cases",
	params: journeyParamsSchema,
	query: null,
	body: addJourneyCaseSchema,
	response: journeyResponseSchema,
	successStatuses: [201],
});

export const updateJourneyCaseContract = defineApiContract({
	id: "journeys.cases.update",
	method: "PATCH",
	path: "/api/projects/:projectId/journeys/:journeyId/cases/:caseId",
	params: journeyCaseParamsSchema,
	query: null,
	body: journeyCaseWriteSchema,
	response: journeyResponseSchema,
	successStatuses: [200],
});

export const archiveJourneyCaseContract = defineApiContract({
	id: "journeys.cases.archive",
	method: "DELETE",
	path: "/api/projects/:projectId/journeys/:journeyId/cases/:caseId",
	params: journeyCaseParamsSchema,
	query: z.object({
		expectedRevision: z.coerce.number().int().nonnegative(),
	}),
	body: null,
	response: journeyResponseSchema,
	successStatuses: [200],
});

export const runJourneyContract = defineApiContract({
	id: "journeys.run",
	method: "POST",
	path: "/api/projects/:projectId/journeys/:journeyId/verifications",
	params: journeyParamsSchema,
	query: null,
	body: clientIntentBodySchema,
	response: dispatchedRunResponseSchema,
	successStatuses: [200, 201],
});

export const retryJourneyContract = defineApiContract({
	id: "journeys.retry",
	method: "POST",
	path: "/api/projects/:projectId/verifications/:runId/cases/:caseRunId/retry",
	params: retryCaseParamsSchema,
	query: null,
	body: clientIntentBodySchema,
	response: dispatchedRunResponseSchema,
	successStatuses: [200, 201],
});

export const updateJourneyScheduleContract = defineApiContract({
	id: "journeys.schedule.update",
	method: "PUT",
	path: "/api/projects/:projectId/journeys/:journeyId/schedule",
	params: journeyParamsSchema,
	query: null,
	body: z.object({
		cadence: z.enum(PUBLIC_SUITE_SCHEDULES_CADENCE_VALUES),
		localTime: z.string().nullable(),
		cronExpression: z.string().nullable().optional(),
		timezone: z.string().nullable(),
	}),
	response: z.object({ schedule: scheduleSchema }),
	successStatuses: [200],
});
