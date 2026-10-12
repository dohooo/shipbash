import { z } from "zod";

import { PUBLIC_PROPOSALS_KIND_VALUES, PUBLIC_PROPOSALS_STATUS_VALUES } from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import { runViewSchema } from "./journeys.ts";
import {
  activityStatusSchema,
  clientIntentBodySchema,
  emptyBodySchema,
  expectedRevisionSchema,
  idSchema,
  journeyParamsSchema,
  mutableJourneyCaseSchema,
  nonEmptyTextSchema,
  proposalParamsSchema,
  suiteCaseDefinitionSchema,
  timestampSchema,
} from "./primitives.ts";

export const proposalViewSchema = z.object({
  id: z.string(),
  kind: z.enum(PUBLIC_PROPOSALS_KIND_VALUES),
  status: z.enum(PUBLIC_PROPOSALS_STATUS_VALUES),
  sourceActivityId: idSchema.nullable(),
  targetSuiteId: z.string().nullable(),
  targetSuiteName: z.string().nullable(),
  proposedSuiteName: z.string().nullable(),
  baseDefinitionRevision: z.number().int().nullable(),
  productThesis: z.string().nullable(),
  candidateDefinition: z.array(suiteCaseDefinitionSchema),
  action: z.enum(["confirm_and_run", "create_suite", "apply_changes"]),
  // Per-case staged-edit instructions, keyed by case id. Non-null only for
  // the journey-edit staging draft (trigger kind "journey_edit").
  journeyEditInstructions: z.record(z.string(), z.string()).nullable(),
  // The candidates that reproduce a live Case of the target Suite exactly:
  // approved Journeys a Discovery carried as its baseline, not drafts. The
  // review shows them as approved and never offers to discard one.
  unchangedCaseIds: z.array(z.string()),
  // The drafts a keep decides on, the ids accept's keep may name: every
  // unarchived candidate not in unchangedCaseIds, and every removal of a
  // live Case (an archived candidate naming one). Empty on a staging draft.
  draftCaseIds: z.array(z.string()),
  // The latest edit walk started from a staging draft; null before one has
  // started and on every other proposal.
  walk: z.object({ activityId: idSchema, status: activityStatusSchema }).nullable(),
  // The staging draft this proposal is an edit walk's result for. Such a
  // result is kept or discarded only with its draft; null on every other
  // proposal.
  editWalkDraftId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const proposalDecisionResponseSchema = z.object({
  proposal: proposalViewSchema,
  suiteId: z.string().nullable(),
  // Keeping drafts: the verification of what landed, or null when it did
  // not start, with the reason in runRefusal — or with none when a run walks
  // nothing the keep landed. The keep stands either way.
  run: runViewSchema.nullable().optional(),
  // runId: the Suite's run under way (VERIFICATION_IN_PROGRESS); the same
  // keep sent again once it ends starts the verification.
  runRefusal: z.object({ error: z.string(), message: z.string(), runId: z.string().optional() }).optional(),
  outcome: z.enum(["applied", "superseded"]).optional(),
  // A keep: the Cases it changed on the Suite (added, rewritten or archived),
  // by id; empty when superseded. Absent on a discard.
  kept: z.array(idSchema).optional(),
});

/**
 * Keeps a proposal. expectedUpdatedAt is the proposal's updatedAt as the
 * caller read it. A journey-edit staging draft is kept whole, and walkId is
 * required for it: the walk the caller reviewed, which must be the draft's
 * latest. The server applies what that walk proved and retires the draft.
 *
 * Any other proposal's drafts are kept as their walk delivered them: keep
 * names the drafts to keep, all of them when absent. The Journeys the change
 * leaves as they are (unchangedCaseIds) are always kept, and a hook scoped to
 * a discarded new Journey goes with it. A draft not kept leaves the live
 * Journey it would rewrite or remove as it is; only a kept removal archives
 * one, and a live Journey the change leaves out stays. A keep naming no candidate of the
 * proposal is 400 UNKNOWN_DRAFT, one keeping no draft 400 NOTHING_KEPT; while
 * a follow-up walk revises the drafts, 409 WALK_NOT_FINISHED. The same keep
 * sent again is answered with its first result, a different one with 409
 * DRAFTS_DECIDED. What landed is then verified (run).
 */
export const acceptProposalContract = defineApiContract({
  id: "proposals.accept",
  method: "POST",
  path: "/api/projects/:projectId/proposals/:proposalId/accept",
  params: proposalParamsSchema,
  query: null,
  body: z.object({
    expectedUpdatedAt: nonEmptyTextSchema(100),
    walkId: idSchema.optional(),
    keep: z.array(idSchema).max(500).optional(),
  }),
  response: proposalDecisionResponseSchema,
  successStatuses: [200, 201],
});

export const rejectProposalContract = defineApiContract({
  id: "proposals.reject",
  method: "POST",
  path: "/api/projects/:projectId/proposals/:proposalId/reject",
  params: proposalParamsSchema,
  query: null,
  body: emptyBodySchema,
  response: proposalDecisionResponseSchema,
  successStatuses: [200],
});

export const getProposalContract = defineApiContract({
  id: "proposals.get",
  method: "GET",
  path: "/api/projects/:projectId/proposals/:proposalId",
  params: proposalParamsSchema,
  query: null,
  body: null,
  response: proposalViewSchema,
  successStatuses: [200],
});

export const followUpProposalBodySchema = clientIntentBodySchema.extend({
  instruction: nonEmptyTextSchema(2_000),
});

// Journey-scoped path, but defined here: the response carries proposalViewSchema
// and journeys.ts cannot import this module without a cycle (proposals.ts
// already imports runViewSchema from journeys.ts).
export const stageJourneyEditContract = defineApiContract({
  id: "journeys.cases.stageEdit",
  method: "POST",
  path: "/api/projects/:projectId/journeys/:journeyId/cases/:caseId/stage-edit",
  params: journeyParamsSchema.extend({ caseId: idSchema }),
  query: null,
  body: z.object({
    // "" is allowed when the case content itself changed; the server 400s
    // with NOTHING_TO_STAGE when neither differs.
    instruction: z.string().trim().max(2_000),
    case: mutableJourneyCaseSchema,
    expectedRevision: expectedRevisionSchema,
  }),
  response: z.object({ proposal: proposalViewSchema }),
  successStatuses: [200],
});
