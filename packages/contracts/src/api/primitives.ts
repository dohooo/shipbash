import { z } from "zod";

import {
	PUBLIC_ACTIVITIES_STATUS_VALUES,
	PUBLIC_CASE_RUNS_VERDICT_VALUES,
	PUBLIC_PROJECTS_AGENT_RUNTIME_VALUES,
	PUBLIC_SUITE_CASES_REPEAT_VALUES,
	PUBLIC_SUITE_CASES_ROLE_VALUES,
	PUBLIC_SUITE_RUNS_FINALIZATION_STATUS_VALUES,
	PUBLIC_SUITE_RUNS_STATUS_VALUES,
	PUBLIC_SUITE_RUNS_TRIGGER_KIND_VALUES,
	PUBLIC_SUITE_RUNS_VERDICT_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { OWNER_CONFIRMATIONS } from "../runtime/case-role-contract.mjs";
import {
	normalizeJourneyCheckpoints,
	normalizeJourneySteps,
} from "../journey-contracts.ts";

export const idSchema = z.string().trim().min(1).max(200);
export const timestampSchema = z.string().min(1);
export const nullableTimestampSchema = timestampSchema.nullable();
export const safeDataSchema = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const nonEmptyTextSchema = (maximum: number) =>
	z.string().trim().min(1).max(maximum);

export const optionalTextSchema = (maximum: number) =>
	z.preprocess(
		(value) => (value === "" ? null : value),
		z.union([nonEmptyTextSchema(maximum), z.null()]).optional(),
	);

export const projectParamsSchema = z.object({ projectId: idSchema });
export const teamParamsSchema = z.object({ teamId: idSchema });
export const activityParamsSchema = projectParamsSchema.extend({
	activityId: idSchema,
});
export const proposalParamsSchema = projectParamsSchema.extend({
	proposalId: idSchema,
});
export const verificationParamsSchema = projectParamsSchema.extend({
	runId: idSchema,
});
export const journeyParamsSchema = projectParamsSchema.extend({
	journeyId: idSchema,
});

export const agentRuntimeSchema = z.enum(PUBLIC_PROJECTS_AGENT_RUNTIME_VALUES);
export const activityStatusSchema = z.enum(PUBLIC_ACTIVITIES_STATUS_VALUES);
export const caseRunVerdictSchema = z.enum(PUBLIC_CASE_RUNS_VERDICT_VALUES);
export const suiteRunStatusSchema = z.enum(PUBLIC_SUITE_RUNS_STATUS_VALUES);
export const suiteRunVerdictSchema = z.enum(PUBLIC_SUITE_RUNS_VERDICT_VALUES);
export const suiteRunTriggerSchema = z.enum(PUBLIC_SUITE_RUNS_TRIGGER_KIND_VALUES);
export const suiteRunFinalizationSchema = z.enum(
	PUBLIC_SUITE_RUNS_FINALIZATION_STATUS_VALUES,
);

export const journeyStepSchema = z.object({
	id: idSchema,
	instruction: nonEmptyTextSchema(20_000),
});

export const journeyCheckpointSchema = z.object({
	id: idSchema,
	goal: nonEmptyTextSchema(1_000),
	afterStep: idSchema.nullable().optional(),
});

const journeyStepsInputSchema = z
	.union([
		nonEmptyTextSchema(20_000),
		z.array(z.union([nonEmptyTextSchema(20_000), journeyStepSchema])),
	])
	.transform((value, context) => {
		if (typeof value === "string") return value;
		try {
			return normalizeJourneySteps(value);
		} catch (error) {
			context.addIssue({
				code: "custom",
				message: error instanceof Error ? error.message : "steps is invalid.",
			});
			return z.NEVER;
		}
	});

const journeyCheckpointsInputSchema = z
	.array(
		z.union([
			nonEmptyTextSchema(1_000),
			journeyCheckpointSchema
				.omit({ id: true })
				.extend({ id: idSchema.optional() }),
		]),
	)
	.transform((value, context) => {
		try {
			return normalizeJourneyCheckpoints(value);
		} catch (error) {
			context.addIssue({
				code: "custom",
				message:
					error instanceof Error ? error.message : "checkpoints is invalid.",
			});
			return z.NEVER;
		}
	});

export const caseRoleSchema = z.enum(PUBLIC_SUITE_CASES_ROLE_VALUES);
export const caseRepeatSchema = z.enum(PUBLIC_SUITE_CASES_REPEAT_VALUES);
export const ownerConfirmationSchema = z.enum(OWNER_CONFIRMATIONS);

export const mutableJourneyCaseSchema = z.object({
	id: idSchema.optional(),
	title: nonEmptyTextSchema(500),
	steps: journeyStepsInputSchema,
	category: nonEmptyTextSchema(120),
	checkpoints: journeyCheckpointsInputSchema,
	whyItMatters: nonEmptyTextSchema(300).nullable().optional(),
	preconditions: z.array(nonEmptyTextSchema(500)).max(10).optional(),
	/** Absent keeps the stored role (a new Case is a Journey). */
	role: caseRoleSchema.optional(),
	/** The Journey a before_each/after_each hook is appended to; null means every Journey. */
	scopeCaseId: idSchema.nullable().optional(),
	repeat: caseRepeatSchema.optional(),
	enabled: z.boolean().optional(),
	archived: z.boolean().optional(),
});

/**
 * The Suite `definitionRevision` a direct write was made against. A Suite
 * that has moved past it refuses the write with 409 REVISION_CONFLICT.
 */
export const expectedRevisionSchema = z.number().int().nonnegative();

export const checklistStatusSchema = z.enum([
	"pending",
	"in_progress",
	"passed",
	"failed",
	"blocked",
	"not_run",
]);

export const caseChecklistItemSchema = z.object({
	id: idSchema,
	goal: z.string(),
	status: checklistStatusSchema,
	reason: z.string().nullable(),
});

export const caseResultSchema = z.object({
	runId: idSchema,
	isPublic: z.boolean(),
	caseRunId: idSchema,
	verdict: caseRunVerdictSchema.nullable(),
	runAt: timestampSchema,
	durationMs: z.number().int().nonnegative().nullable(),
});

export const suiteCaseDefinitionSchema = z.object({
	id: idSchema.optional(),
	title: nonEmptyTextSchema(500),
	steps: z.array(journeyStepSchema),
	category: nonEmptyTextSchema(120),
	checkpoints: z.array(journeyCheckpointSchema),
	whyItMatters: z.string().nullable(),
	/** The server always sends an array (normalizeCaseInputs); optional only tolerates rows written before the column. */
	preconditions: z.array(z.string()).optional(),
	/** The server always sends the three (normalizeCaseInputs); optional tolerates candidates written before hooks. */
	role: caseRoleSchema.optional(),
	scopeCaseId: idSchema.nullable().optional(),
	repeat: caseRepeatSchema.optional(),
	/** A proposed hook's declaration for the review; never stored on a Suite Case. */
	ownerConfirmation: ownerConfirmationSchema.optional(),
	enabled: z.boolean().optional(),
	archived: z.boolean().optional(),
});

export const emptyBodySchema = z.object({});
export const clientIntentBodySchema = z.object({
	clientIdempotencyKey: nonEmptyTextSchema(200),
});
