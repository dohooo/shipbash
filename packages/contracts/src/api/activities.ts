import { z } from "zod";

import {
  PUBLIC_ACTIVITIES_KIND_VALUES,
  PUBLIC_ACTIVITIES_TRIGGER_SOURCE_VALUES,
  PUBLIC_ACTIVITY_EVENTS_KIND_VALUES,
  PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES,
  PUBLIC_ACTIVITY_RESULTS_KIND_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import {
  activityParamsSchema,
  activityStatusSchema,
  caseRoleSchema,
  clientIntentBodySchema,
  idSchema,
  nonEmptyTextSchema,
  optionalTextSchema,
  proposalParamsSchema,
  safeDataSchema,
  timestampSchema,
} from "./primitives.ts";
import { followUpProposalBodySchema, proposalViewSchema } from "./proposals.ts";

export { activityStatusSchema } from "./primitives.ts";
export const activityEventKindSchema = z.enum(PUBLIC_ACTIVITY_EVENTS_KIND_VALUES);

/** The evidence bundle names a walk or Discovery by its id alone, which the store casts to a uuid. */
export const activityEvidenceParamsSchema = z.object({ activityId: z.uuid() });

export const activityViewSchema = z.object({
  id: idSchema,
  kind: z.enum(PUBLIC_ACTIVITIES_KIND_VALUES),
  triggerSource: z.enum(PUBLIC_ACTIVITIES_TRIGGER_SOURCE_VALUES),
  status: activityStatusSchema,
  resultLabel: z.string().nullable(),
  /** The Activity this one continued or retried — the page's chain walks it. */
  sourceActivityId: idSchema.nullable(),
  updatedAt: timestampSchema,
});

export const activityEventViewSchema = z.object({
  id: idSchema,
  sequence: z.number().int().nonnegative(),
  kind: activityEventKindSchema,
  label: z.string(),
  bodyMarkdown: z.string().nullable(),
  safeData: safeDataSchema,
  createdAt: timestampSchema,
});

const activityResultSchema = z.object({
  activityId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
  kind: z.enum(PUBLIC_ACTIVITY_RESULTS_KIND_VALUES),
  summary: z.string(),
  attentionCode: z.enum(PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES).nullable(),
  recoveryAction: z.string().nullable(),
  proposalIds: z.array(idSchema),
  createdAt: timestampSchema,
});

/**
 * What a walk leaves for the reader to keep or discard; proposalId is what
 * accept and reject act on, and proposalUpdatedAt is what accept sends back
 * as expectedUpdatedAt.
 *
 * "journey_edit" (an edit walk): proposalId is the staging draft, and accept
 * sends this walk's id as walkId. Only the latest walk of a draft still
 * undecided is actionable. The cases are everything keeping applies: the
 * staged journeys (change "staged"), then each case the walk added, changed
 * or removed beyond them. Each script is diffed against live: "new" rows the
 * reader staged, "agent" rows the walk added, "del" live rows dropped.
 *
 * "drafts" (any other walk): proposalId is the newest proposal the walk
 * delivered, actionable once the walk has ended, while no follow-up walk of
 * it runs and until it is decided. The cases are its drafts, the candidates
 * keep may name: "added" and "changed" (a live case rewritten) with every row
 * "new", "removed" (a live case archived) with every row "del". The Journeys
 * it leaves as they are are not listed, and a decided proposal lists none.
 *
 * reason says why a review is not actionable, null when it is: the staged
 * edits were kept or discarded (EDITS_DECIDED), a later walk of them exists
 * (WALK_NOT_LATEST), the ended walk proved none of the staged edits
 * (NOTHING_PROVED: walk them again or discard them), the drafts were kept or
 * discarded or a later walk replaced them (DRAFTS_DECIDED), or a walk is at
 * work on the drafts (WALK_NOT_FINISHED).
 */
export const activityReviewSchema = z.object({
  proposalId: idSchema,
  proposalUpdatedAt: timestampSchema,
  kind: z.enum(["journey_edit", "drafts"]),
  actionable: z.boolean(),
  reason: z.enum(["EDITS_DECIDED", "WALK_NOT_LATEST", "NOTHING_PROVED", "DRAFTS_DECIDED", "WALK_NOT_FINISHED"]).nullable(),
  cases: z.array(z.object({
    id: idSchema,
    title: z.string(),
    category: z.string(),
    whyItMatters: z.string().nullable(),
    role: caseRoleSchema,
    scopeCaseId: idSchema.nullable(),
    change: z.enum(["staged", "added", "changed", "removed"]),
    status: z.enum(["walking", "ready", "failed"]),
    rows: z.array(z.object({
      kind: z.enum(["step", "should"]),
      text: z.string(),
      mark: z.enum(["same", "new", "agent", "del"]),
    })),
  })),
});

/** A question the walk asked; the answer sends option (one of options) or, when allowFreeText, freeText. */
export const activityPendingQuestionSchema = z.object({
  questionId: z.string(),
  prompt: z.string(),
  options: z.array(z.string()),
  allowFreeText: z.boolean(),
});

const createActivityBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initial_discovery"),
    message: optionalTextSchema(4_000),
    clientIdempotencyKey: nonEmptyTextSchema(200),
  }),
  z.object({
    kind: z.literal("generate_cases"),
    message: optionalTextSchema(4_000),
    targetSuiteId: optionalTextSchema(200),
    clientIdempotencyKey: nonEmptyTextSchema(200),
  }),
]);

export const createActivityContract = defineApiContract({
  id: "createActivity",
  method: "POST",
  path: "/api/projects/:projectId/activities",
  params: activityParamsSchema.pick({ projectId: true }),
  query: null,
  body: createActivityBodySchema,
  response: z.object({ activity: activityViewSchema }),
  successStatuses: [201],
});

export const cancelActivityContract = defineApiContract({
  id: "cancelActivity",
  method: "POST",
  path: "/api/projects/:projectId/activities/:activityId/cancel",
  params: activityParamsSchema,
  query: null,
  body: null,
  response: z.object({ result: activityResultSchema }),
  successStatuses: [200],
});

export const retryActivityContract = defineApiContract({
  id: "retryActivity",
  method: "POST",
  path: "/api/projects/:projectId/activities/:activityId/retry",
  params: activityParamsSchema,
  query: null,
  body: z.object({ clientIdempotencyKey: nonEmptyTextSchema(200) }),
  response: z.object({ activity: activityViewSchema }),
  successStatuses: [201],
});

export const answerActivityContract = defineApiContract({
  id: "answerActivityQuestion",
  method: "POST",
  path: "/api/projects/:projectId/activities/:activityId/answer",
  params: activityParamsSchema,
  query: null,
  body: z.object({
    questionId: nonEmptyTextSchema(64),
    option: optionalTextSchema(120),
    freeText: optionalTextSchema(2_000),
    note: optionalTextSchema(2_000),
    skipped: z.boolean().optional().default(false),
  }),
  response: z.object({ answered: z.literal(true) }),
  successStatuses: [200],
});

/**
 * Stops a walk under way, and says how. A Discovery with a leg at work wraps
 * up: it keeps what it found and delivers it ("wrapping_up"). Any other walk,
 * and a Discovery with no leg at work (queued, waiting for a sign-in, just
 * woken), is canceled ("canceled"). An ended walk is 409 ACTIVITY_NOT_RUNNING.
 */
export const stopActivityContract = defineApiContract({
  id: "stopActivity",
  method: "POST",
  path: "/api/projects/:projectId/activities/:activityId/stop",
  params: activityParamsSchema,
  query: null,
  body: null,
  response: z.object({ stopped: z.enum(["wrapping_up", "canceled"]) }),
  successStatuses: [200],
});

export const steerActivityContract = defineApiContract({
  id: "steerActivity",
  method: "POST",
  path: "/api/projects/:projectId/activities/:activityId/steer",
  params: activityParamsSchema,
  query: null,
  body: z.object({
    message: nonEmptyTextSchema(4_000),
    // Opaque client id: the console folds its optimistic row onto the
    // steer_requested event that echoes it.
    clientKey: nonEmptyTextSchema(200),
  }),
  response: z.object({ accepted: z.literal(true) }),
  successStatuses: [200],
});

export const getActivityContract = defineApiContract({
  id: "getActivity",
  method: "GET",
  path: "/api/projects/:projectId/activities/:activityId",
  params: activityParamsSchema,
  query: null,
  body: null,
  response: activityViewSchema.extend({
    // What this walk leaves to keep or discard; null when it leaves nothing.
    review: activityReviewSchema.nullable(),
    // The question the walk is waiting on: set while the Activity is
    // waiting_for_input and nothing has answered, skipped or withdrawn it.
    pendingQuestion: activityPendingQuestionSchema.nullable(),
    // Whether a message steers this walk: a live walk folds it in, a
    // delivered Discovery wakes with it. Otherwise steer answers 409.
    steerable: z.boolean(),
    // Whether a retry walks it again as a new walk: it ended without a
    // delivery (failed, canceled, needs attention, superseded). Otherwise
    // retry answers 409 ACTIVITY_NOT_RETRYABLE.
    retryable: z.boolean(),
    // The owner's Stop on the record: the footer reads Stopping… and the
    // composer closes from this, not from the click, so a refresh keeps them.
    wrapUpRequestedAt: z.string().nullable(),
    finalScreenshotUrl: z.string().nullable(),
    // The live stream address travels as its own field: `events` is a
    // 300-entry tail, and the one browser_stream_ready event falls out of
    // that window on long runs. streamRevision counts announcements so a
    // replacement stream forces a fresh viewer socket.
    streamUrl: z.string().nullable(),
    streamRevision: z.number().int().nonnegative(),
    // Retained terminal sessions, derived from the FULL event list for the
    // same reason as streamUrl: their activity_terminal_log events land
    // mid-run and would silently fall out of the 300-event tail.
    terminalLogSessionIds: z.array(z.string()),
    events: z.array(activityEventViewSchema),
    // The latest delivery: while status is non-terminal (a woken leg
    // running), this is the PREVIOUS round's deliverable.
    result: z
      .object({
        kind: activityResultSchema.shape.kind,
        summary: z.string(),
        attentionCode: activityResultSchema.shape.attentionCode,
        recoveryAction: z.string().nullable(),
        proposals: z.array(proposalViewSchema),
      })
      .nullable(),
  }),
  successStatuses: [200],
});

/**
 * Asks for changes to a proposal's drafts, as a new walk; nothing edits a
 * draft directly. A Discovery's list is continued by a Discovery that starts
 * from it; any other proposal by a walk of its target Suite. The walk names
 * the proposal, its delivery supersedes it, and while it runs the drafts are
 * not kept (409 WALK_NOT_FINISHED). One walk of a proposal runs at a time
 * (409 WALK_RUNNING); a decided proposal takes none (409 DRAFTS_DECIDED).
 */
export const followUpProposalContract = defineApiContract({
  id: "proposals.followUp",
  method: "POST",
  path: "/api/projects/:projectId/proposals/:proposalId/follow-up",
  params: proposalParamsSchema,
  query: null,
  body: followUpProposalBodySchema,
  response: z.object({ activity: activityViewSchema }),
  successStatuses: [201],
});

/** Verifies a staged journey-edit draft by dispatching a generate_cases run. */
export const startJourneyEditRunContract = defineApiContract({
  id: "proposals.editRun",
  method: "POST",
  path: "/api/projects/:projectId/proposals/:proposalId/edit-run",
  params: proposalParamsSchema,
  query: null,
  body: clientIntentBodySchema,
  response: z.object({ activity: activityViewSchema }),
  successStatuses: [201],
});
