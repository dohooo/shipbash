import { z } from "zod";

import { activityEventViewSchema, activityStatusSchema } from "./activities.ts";
import { defineApiContract } from "./core.ts";
import {
	activityParamsSchema,
	idSchema,
	verificationParamsSchema,
} from "./primitives.ts";
import { liveRunCaseSchema, liveRunViewSchema, runEventViewSchema } from "./runs.ts";

export const activityEventFrameSchema = activityEventViewSchema.extend({
	status: activityStatusSchema,
});

/**
 * Browser ingress is deliberately one step more permissive than the server
 * response contract. The server must emit primitive-only safeData, while an
 * origin script can inject an arbitrary SSE frame before the browser-side
 * sanitizer runs. Keep every structural field shared and let that sanitizer
 * reduce only the untrusted safeData payload.
 */
export const activityEventClientFrameSchema = activityEventFrameSchema
	.omit({ safeData: true })
	.extend({ safeData: z.unknown() });

export const activityDoneFrameSchema = z.object({
	status: activityStatusSchema,
	lastSequence: z.number().int().nonnegative(),
});

export const activitySseFrameSchema = z.union([
	activityEventFrameSchema,
	activityDoneFrameSchema,
]);

export const activityEventsContract = defineApiContract({
	id: "streamActivityEvents",
	method: "GET",
	path: "/api/projects/:projectId/activities/:activityId/events",
	params: activityParamsSchema,
	query: z.object({ after: z.string().optional() }),
	body: null,
	response: activitySseFrameSchema,
	successStatuses: [200],
});

/**
 * What a stream frame says of each Case: everything a live run page shows of
 * it that changes while the run walks — the snapshot Case it is, the walk now
 * on show, where it stands, its verdict, its checkpoints and when the walk
 * started and ended. A Case as a read answers it (`liveRunCaseSchema`)
 * carries its artifacts, recording and trust too; those are the read's, and a
 * frame is sent on every event of a live run, to every viewer, so it never
 * carries them. Parsing a read's Case with it leaves exactly this.
 */
export const runStreamCaseSchema = liveRunCaseSchema
	.pick({ id: true, snapshotCaseId: true, status: true, verdict: true })
	.extend({
		detail: liveRunCaseSchema.shape.detail.pick({ checklist: true, startedAt: true, completedAt: true }),
	});

const runStateFrameFields = {
	status: liveRunViewSchema.shape.status,
	verdict: liveRunViewSchema.shape.verdict,
	currentCaseRunId: liveRunViewSchema.shape.currentCaseRunId,
	takeoverActive: liveRunViewSchema.shape.takeoverActive,
	streamUrl: liveRunViewSchema.shape.streamUrl,
	startedAt: liveRunViewSchema.shape.startedAt,
	completedAt: liveRunViewSchema.shape.completedAt,
	cases: z.array(runStreamCaseSchema).readonly(),
};

export const runEventFrameSchema =
	runEventViewSchema.extend(runStateFrameFields);

export const runStatusFrameSchema = z.object({
	eventType: z.literal("run_status"),
	...runStateFrameFields,
});

export const runDoneFrameSchema = z.object({
	status: z.enum(["completed", "canceled"]),
	lastSequence: z.number().int().nonnegative(),
});

export const runMessageFrameSchema = z.union([
	runEventFrameSchema,
	runStatusFrameSchema,
]);

export const runSseFrameSchema = z.union([
	runMessageFrameSchema,
	runDoneFrameSchema,
]);

export const runEventsContract = defineApiContract({
	id: "streamVerificationEvents",
	method: "GET",
	path: "/api/projects/:projectId/verifications/:runId/events",
	params: verificationParamsSchema,
	query: z.object({ after: z.string().optional() }),
	body: null,
	response: runSseFrameSchema,
	successStatuses: [200],
});

/**
 * The log of `run`, the member of the run's family its page names as
 * `eventsRunId`: each line written after `after`, and the sequence the next
 * read goes on from. A run outside the family is not found.
 */
export const getVerificationLogContract = defineApiContract({
	id: "verifications.log",
	method: "GET",
	path: "/api/projects/:projectId/verifications/:runId/log",
	params: verificationParamsSchema,
	query: z.object({ run: idSchema, after: z.coerce.number().int().nonnegative().default(0) }).strict(),
	body: null,
	response: z.object({ events: z.array(runEventViewSchema).readonly(), nextAfter: z.number().int().nonnegative() }),
	successStatuses: [200],
});
