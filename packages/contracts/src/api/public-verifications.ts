import { z } from "zod";
import { RUN_ID_PATTERN, SLUG_PATTERN } from "../run-address.ts";
import { runCardFactsSchema } from "../run-card.ts";
import { AGENT_POINTER_ACTIONS } from "../runtime/agent-pointer-actions.mjs";
import { defineApiContract } from "./core.ts";
import { idSchema } from "./primitives.ts";

const publicTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const publicParamsSchema = z.object({ token: publicTokenSchema }).strict();
const publicStatusSchema = z.enum(["queued", "running", "waiting_for_auth", "canceling", "canceled", "completed"]);
const publicVerdictSchema = z.enum(["passed", "failed", "blocked", "error", "canceled"]);

export const publicVerificationSchema = z.object({
  id: idSchema,
  projectName: z.string(),
  suiteName: z.string().nullable(),
  sharedBy: z.string().nullable(),
  sharedAt: z.string().datetime().nullable(),
  status: publicStatusSchema,
  verdict: publicVerdictSchema.nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  /**
   * Whose log the page reads: the shared run's own, or the retry now walking
   * one of its Journeys. The log is read by this id, so a page whose walk
   * changes reads that walk's log from its start instead of appending it to
   * the one it had.
   */
  eventsRunId: idSchema,
  cases: z.array(z.object({
    id: idSchema,
    caseRunId: idSchema.nullable(),
    title: z.string(),
    role: z.enum(["journey", "before_all", "before_each", "after_each", "after_all"]),
    scopeCaseId: idSchema.nullable(),
    steps: z.string(),
    checkpoints: z.array(z.object({ id: idSchema, goal: z.string(), status: z.enum([
      "pending", "in_progress", "passed", "failed", "blocked", "not_run",
    ]), reason: z.string().nullable() }).strict()),
    status: z.enum(["queued", "running", "waiting_for_auth", "canceled", "completed"]),
    verdict: z.enum(["passed", "failed", "blocked", "error", "canceled", "exempted", "not_run"]).nullable(),
    summary: z.string().nullable(),
    failureReason: z.string().nullable(),
    // With completedAt, how long the walk took — the rail reads the same
    // duration an operator sees, so the two rails cannot drift.
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    recordingState: z.enum(["preparing", "uploading", "ready", "failed", "missing"]).nullable(),
    recording: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
      durationMs: z.number().nonnegative(),
      contentUrl: z.string(),
      posterUrl: z.string().nullable(),
      /**
       * What the operator's player draws over the walk, on the video's own
       * timeline, read off the same playback document. Its words — chapter
       * titles, captions, shell labels — are the ones the runner masked whole
       * before it wrote the document, and titles and captions then pass the
       * prose sanitizer every agent sentence on a share passes; a document the
       * runner did not mask shares none of its words. A chapter is a title
       * and the span it covers.
       */
      chapters: z.array(z.object({
        id: z.string(),
        title: z.string(),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
      }).strict()),
      /** The agent's narration, each caption over the span it is shown. */
      cues: z.array(z.object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        caption: z.string(),
      }).strict()),
      /** Each Agent action: when, where on the page as a fraction of it, and what it was. */
      pointers: z.array(z.object({
        atMs: z.number().int().nonnegative(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        action: z.enum(AGENT_POINTER_ACTIONS),
      }).strict()),
      /**
       * Each move of the walk between the browser and a shell: the shell by
       * the id the runner gave it, and the program first run there.
       */
      attention: z.array(z.object({
        atMs: z.number().int().nonnegative(),
        surface: z.enum(["browser", "terminal"]),
        sessionId: z.string().nullable(),
        label: z.string().nullable(),
      }).strict()),
      /**
       * The stretches where nothing on the page moved, and the rate the
       * player plays each at, as the operator's player does. Times and a
       * rate only.
       */
      speedSegments: z.array(z.object({
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().positive(),
        playbackRate: z.number().positive(),
        reason: z.literal("static"),
      }).strict()),
      /**
       * The video's wall clock: each recorded segment's place on the timeline
       * and the epoch millisecond of its first frame. It places each shell's
       * output on the video, as the operator's replay does.
       */
      anchors: z.array(z.object({
        startMs: z.number().int().nonnegative(),
        durationMs: z.number().int().positive(),
        startedAt: z.number().int().positive(),
      }).strict()),
    }).strict().nullable(),
    screenshotUrl: z.string().nullable(),
    /**
     * The shell logs the walk kept, each masked whole once its session ended.
     * A log recorded before masking is never listed, and the media route
     * serves a log only when this list names it.
     */
    terminalLogs: z.array(z.object({
      sessionId: z.string().regex(/^term-[A-Za-z0-9_-]{1,120}$/u),
      url: z.string(),
    }).strict()),
  }).strict()),
}).strict();
export type PublicVerification = z.output<typeof publicVerificationSchema>;

export const getPublicVerificationContract = defineApiContract({
  id: "getPublicVerification",
  method: "GET",
  path: "/api/public/verifications/:token",
  params: publicParamsSchema,
  query: null,
  body: null,
  response: z.object({ verification: publicVerificationSchema }).strict(),
  successStatuses: [200],
});

export const getPublicVerificationEventsContract = defineApiContract({
  id: "getPublicVerificationEvents",
  method: "GET",
  path: "/api/public/verifications/:token/events",
  params: publicParamsSchema,
  query: z.object({
    /** The run whose log this is, as the report names it (`eventsRunId`). */
    run: idSchema,
    after: z.coerce.number().int().nonnegative().default(0),
  }).strict(),
  body: null,
  response: z.object({
    events: z.array(z.object({
      sequence: z.number().int().positive(),
      caseRunId: idSchema.nullable(),
      label: z.string(),
      kind: z.enum(["system", "action", "result"]),
      level: z.enum(["info", "warning", "error"]),
      elapsedMs: z.number().nonnegative(),
      count: z.number().int().positive(),
      createdAt: z.string().datetime(),
    }).strict()),
    nextAfter: z.number().int().nonnegative(),
  }).strict(),
  successStatuses: [200],
});
export type PublicEvent = z.output<typeof getPublicVerificationEventsContract.response>["events"][number];

/**
 * Folds each run of adjacent events with the same label, kind, level and Case
 * into its last event, counting them: the store groups one read, the page
 * groups again across its reads.
 */
export function groupPublicEvents(events: readonly PublicEvent[]): PublicEvent[] {
  const rows: PublicEvent[] = [];
  for (const event of events) {
    const last = rows.at(-1);
    if (last && last.label === event.label && last.kind === event.kind && last.level === event.level && last.caseRunId === event.caseRunId) {
      rows[rows.length - 1] = { ...event, count: last.count + event.count };
    } else rows.push(event);
  }
  return rows;
}

/**
 * A private run's card, read without a session: what an unfurl of the run's
 * own address shows. An address in no form the database writes, an unknown
 * run, a run not under these slugs and a run with no card all answer the
 * same 404.
 */
export const getPublicRunCardContract = defineApiContract({
  id: "getPublicRunCard",
  method: "GET",
  path: "/api/public/verifications/by-run/:teamSlug/:projectSlug/:runId/card",
  params: z.object({
    teamSlug: z.string().regex(SLUG_PATTERN),
    projectSlug: z.string().regex(SLUG_PATTERN),
    runId: z.string().regex(RUN_ID_PATTERN),
  }).strict(),
  query: null,
  body: null,
  response: z.object({ card: runCardFactsSchema }).strict(),
  successStatuses: [200],
});

export const verificationShareParamsSchema = z.object({
  projectId: idSchema,
  runId: idSchema,
});

export const verificationShareResponseSchema = z.object({
  isPublic: z.boolean(),
  shareUrl: z.string().nullable(),
  /**
   * Each Case's id on the shared page, by its snapshot Case id. The shared
   * page names every Case by an id of its own link, so a link that opens it on
   * one journey names it this way. Empty while the run is private.
   */
  caseIds: z.record(z.string(), idSchema),
});
export type VerificationShare = z.output<typeof verificationShareResponseSchema>;

export const getVerificationShareContract = defineApiContract({
  id: "getVerificationShare",
  method: "GET",
  path: "/api/projects/:projectId/verifications/:runId/share",
  params: verificationShareParamsSchema,
  query: null,
  body: null,
  response: verificationShareResponseSchema,
  successStatuses: [200],
});

export const updateVerificationShareContract = defineApiContract({
  id: "updateVerificationShare",
  method: "PUT",
  path: "/api/projects/:projectId/verifications/:runId/share",
  params: verificationShareParamsSchema,
  query: null,
  body: z.object({ isPublic: z.boolean() }).strict(),
  response: verificationShareResponseSchema,
  successStatuses: [200],
});
