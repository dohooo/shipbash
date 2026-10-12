import { z } from "zod";

import {
	PUBLIC_CASE_RUNS_REPRODUCED_RUNS_VALUES,
	PUBLIC_CASE_RUNS_STATUS_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import { runDispatchSchema, runViewSchema } from "./journeys.ts";
import {
	caseChecklistItemSchema,
	caseRoleSchema,
	caseRunVerdictSchema,
	clientIntentBodySchema,
	idSchema,
	nullableTimestampSchema,
	suiteRunFinalizationSchema,
	suiteRunStatusSchema,
	suiteRunTriggerSchema,
	suiteRunVerdictSchema,
	timestampSchema,
	verificationParamsSchema,
} from "./primitives.ts";

const uiCaseStatusSchema = z.enum(PUBLIC_CASE_RUNS_STATUS_VALUES);

const artifactLinkSchema = z.object({
	kind: z.string(),
	label: z.string(),
	url: z.string().nullable(),
});

/**
 * A file a walk kept in storage. `curated` says whether the run chose to keep
 * it (the key screenshot, a trace, a session log), or whether the evidence
 * pipeline wrote it, as it does of every walk: the files named `evidence-…`,
 * a frame per step, the page's console and the manifest.
 */
const caseArtifactSchema = z.object({
	id: idSchema,
	kind: z.string(),
	label: z.string(),
	url: z.string(),
	curated: z.boolean(),
});

const codeEvidenceSchema = z.object({
	status: z.enum(["corroborated", "inconclusive"]),
	summary: z.string(),
	commitSha: z.string(),
	files: z.array(
		z.object({
			path: z.string(),
			lineStart: z.number().int().nullable(),
			lineEnd: z.number().int().nullable(),
			rationale: z.string(),
		}),
	),
});

export const browserRecordingViewSchema = z.object({
	id: idSchema,
	contentUrl: z.string(),
	posterUrl: z.string().nullable(),
	chapters: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				startMs: z.number().int().nonnegative(),
				endMs: z.number().int().positive(),
			}),
		)
		.readonly(),
	speedSegments: z
		.array(
			z.object({
				startMs: z.number().int().nonnegative(),
				endMs: z.number().int().positive(),
				playbackRate: z.number().positive(),
				reason: z.literal("static"),
			}),
		)
		.readonly(),
	pointers: z
		.array(
			z.object({
				atMs: z.number().int().nonnegative(),
				x: z.number(),
				y: z.number(),
				action: z.string(),
			}),
		)
		.readonly(),
	cues: z
		.array(
			z.object({
				startMs: z.number().int().nonnegative(),
				endMs: z.number().int().positive(),
				caption: z.string(),
			}),
		)
		.readonly(),
	/** Where the agent was working, on this recording's own timeline. */
	attention: z
		.array(
			z.object({
				atMs: z.number().int().nonnegative(),
				surface: z.enum(["browser", "terminal"]),
				sessionId: z.string().nullable(),
				label: z.string().nullable(),
			}),
		)
		.readonly(),
	/** The run's sandbox shells in the order they were opened. */
	terminal: z
		.array(
			z.object({
				sessionId: z.string(),
				label: z.string(),
				/** Epoch millisecond, matching the session log's own header. */
				startedAt: z.number().int().positive(),
			}),
		)
		.readonly(),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	durationMs: z.number().int().positive(),
	/**
	 * The video's wall clock: each recorded segment's place and length on it,
	 * and the epoch millisecond of its first frame. Empty when it has none.
	 */
	anchors: z
		.array(
			z.object({
				startMs: z.number().int().nonnegative(),
				durationMs: z.number().int().positive(),
				startedAt: z.number().int().positive(),
			}),
		)
		.readonly(),
});

export const liveRunCaseSchema = z.object({
	/** The walk on show once the Case has one, the snapshot Case until then. */
	id: idSchema,
	/** The snapshot Case this row stands for, whichever of its walks it shows. */
	snapshotCaseId: idSchema,
	/** The Journey or hook the snapshot Case was frozen from; null when it names none. */
	suiteCaseId: idSchema.nullable(),
	title: z.string(),
	/** A Journey, or a setup/teardown hook around the run. */
	role: caseRoleSchema,
	/** For a per-journey hook: the sibling snapshot Case id it is appended to. */
	scopeCaseId: idSchema.nullable(),
	status: uiCaseStatusSchema,
	verdict: caseRunVerdictSchema.nullable(),
	retryable: z.boolean(),
	/**
	 * The latest attempt's Case Run id when this row is an earlier walk the
	 * page was asked for, and null when the row is the latest walk itself.
	 */
	supersededBy: idSchema.nullable(),
	/**
	 * Every walk of this Journey the page aggregates, oldest first. The row
	 * shows the latest one, or the attempt the request named; the others are
	 * links back to this same page.
	 */
	attempts: z
		.array(
			z.object({
				caseRunId: idSchema,
				runId: idSchema,
				attempt: z.number().int().positive(),
				status: uiCaseStatusSchema,
				verdict: caseRunVerdictSchema.nullable(),
				completedAt: nullableTimestampSchema,
			}),
		)
		.readonly(),
	detail: z.object({
		summary: z.string().nullable(),
		failureReason: z.string().nullable(),
		trust: z.object({
			reproducedRuns: z.literal(PUBLIC_CASE_RUNS_REPRODUCED_RUNS_VALUES),
			codeEvidence: codeEvidenceSchema.nullable(),
		}),
		checklist: z.array(caseChecklistItemSchema).readonly(),
		screenshotUrl: z.string().nullable(),
		screenshotAlt: z.string(),
		// With completedAt, how long this walk took — the rail's own duration.
		startedAt: nullableTimestampSchema,
		completedAt: nullableTimestampSchema,
		/** Every file of this walk that reached storage, oldest first. */
		artifacts: z.array(caseArtifactSchema).readonly(),
		/**
		 * The shell logs the walk kept, each with its place among the walk's
		 * shells when the recording names one; without it, a log's own header
		 * clock orders it.
		 */
		terminalLogs: z
			.array(
				z.object({
					sessionId: z.string(),
					url: z.string(),
					order: z.number().int().nonnegative().nullable(),
				}),
			)
			.readonly(),
		recording: browserRecordingViewSchema.nullable(),
		recordingState: z.enum(["preparing", "uploading", "ready", "failed", "missing"]).nullable(),
	}),
});

export const runEventViewSchema = z.object({
	id: z.string(),
	eventType: z.string(),
	kind: z.enum(["action", "result", "console", "system"]),
	summary: z.string(),
	detail: z.string().nullable().optional(),
	timestamp: timestampSchema,
	level: z.enum(["info", "warning", "error"]).optional(),
	/** The MCP tool an agent action called, which names the surface it drove. */
	tool: z.string().nullable().optional(),
	artifacts: z.array(artifactLinkSchema).readonly().optional(),
	pointer: z
		.object({
			action: z.string(),
			x: z.number(),
			y: z.number(),
			width: z.number().nonnegative(),
			height: z.number().nonnegative(),
		})
		.nullable()
		.optional(),
});

export const liveRunViewSchema = z.object({
	id: idSchema,
	isPublic: z.boolean(),
	projectName: z.string(),
	suiteLabel: z.string(),
	status: suiteRunStatusSchema,
	verdict: suiteRunVerdictSchema.nullable(),
	/** What started the run: Run now, the schedule, a rerun, a retry of one Journey. */
	triggerKind: suiteRunTriggerSchema.nullable(),
	finalizationStatus: suiteRunFinalizationSchema,
	diagnosticArtifactsUnavailable: z.number().int().nonnegative(),
	actionable: z.boolean(),
	/**
	 * When the family's active run started and ended — the walk the page is
	 * live on — which the page's clock counts from.
	 */
	startedAt: nullableTimestampSchema,
	completedAt: nullableTimestampSchema,
	streamUrl: z.string(),
	authViewerUrl: z.string().nullable(),
	takeoverActive: z.boolean(),
	authPrompt: z.string().nullable(),
	currentCaseRunId: z.string().nullable(),
	/**
	 * Which run's log the page shows: its own run, or the retry now walking one
	 * of its Journeys. The page reads it apart (streams.ts, `getVerificationLogContract`).
	 */
	eventsRunId: idSchema,
	cases: z.array(liveRunCaseSchema).readonly(),
	result: z
		.object({
			verdict: suiteRunVerdictSchema,
			summary: z.string(),
			screenshotUrl: z.string().nullable(),
			screenshotAlt: z.string(),
			completedAt: timestampSchema,
		})
		.nullable(),
});

// The run, and nothing about where the console shows it: the console builds
// its own routes from the run's id.
const runMutationResponseSchema = z.object({
	run: runViewSchema,
});

export const verificationArtifactParamsSchema = verificationParamsSchema.extend(
	{
		artifactId: idSchema,
	},
);

export const caseRunEvidenceParamsSchema = z.object({ caseRunId: idSchema });

export const rerunVerificationContract = defineApiContract({
	id: "verifications.rerun",
	method: "POST",
	path: "/api/projects/:projectId/verifications/:runId/rerun",
	params: verificationParamsSchema,
	query: null,
	body: clientIntentBodySchema,
	response: runMutationResponseSchema.extend({ dispatch: runDispatchSchema }),
	successStatuses: [200, 201],
});

export const cancelVerificationContract = defineApiContract({
	id: "verifications.cancel",
	method: "POST",
	path: "/api/projects/:projectId/verifications/:runId/cancel",
	params: verificationParamsSchema,
	query: null,
	body: null,
	response: runMutationResponseSchema,
	successStatuses: [200, 202],
});

export const getVerificationContract = defineApiContract({
	id: "verifications.get",
	method: "GET",
	path: "/api/projects/:projectId/verifications/:runId",
	params: verificationParamsSchema,
	/**
	 * Which walk the page is asked to show: a Case Run id of the run's family,
	 * which then stands in for that Journey's latest attempt. An id the family
	 * does not hold is ignored, so a stale link still opens the run.
	 */
	query: z.object({ attempt: idSchema.optional() }),
	body: null,
	response: z.object({ view: liveRunViewSchema }),
	successStatuses: [200],
});
