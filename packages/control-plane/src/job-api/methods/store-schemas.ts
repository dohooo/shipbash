/**
 * The zod shapes of the worker store's inputs, one per input type of
 * store/job-store-inputs.ts and the types it names. Each parses to exactly
 * what the store method takes, so the store keeps validating what it always
 * validated. Unknown keys are dropped, never passed on.
 */
import { z } from "zod";

import { OWNER_CONFIRMATIONS } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import {
  PUBLIC_ACTIVITY_EVENTS_KIND_VALUES,
  PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES,
  PUBLIC_ACTIVITY_RESULTS_KIND_VALUES,
  PUBLIC_CASE_RUNS_REPRODUCED_RUNS_VALUES,
  PUBLIC_CASE_RUNS_VERDICT_VALUES,
  PUBLIC_PROPOSALS_KIND_VALUES,
  PUBLIC_RUN_EVENTS_LEVEL_VALUES,
  PUBLIC_SUITE_CASES_REPEAT_VALUES,
  PUBLIC_SUITE_CASES_ROLE_VALUES,
} from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";

import { knowledgeEntrySchema } from "../../knowledge.ts";

/** A batch's ceiling: the write-behind queue flushes at 200 events. */
export const MAX_EVENT_BATCH = 500;

const jsonObject = z.record(z.string(), z.unknown());

export const runEvent = z.object({
  caseRunId: z.string().nullable().exactOptional(),
  type: z.string(),
  level: z.enum(PUBLIC_RUN_EVENTS_LEVEL_VALUES).exactOptional(),
  message: z.string(),
  data: jsonObject.nullable().exactOptional(),
});

export const activityEvent = z.object({
  kind: z.enum(PUBLIC_ACTIVITY_EVENTS_KIND_VALUES),
  label: z.string(),
  bodyMarkdown: z.string().nullable().exactOptional(),
  safeData: jsonObject.exactOptional(),
});

export const checklist = z.array(z.object({
  id: z.string(),
  goal: z.string(),
  status: z.enum(["passed", "failed", "blocked", "not_run", "pending", "in_progress"]),
  reason: z.string().nullable(),
}));

export const caseTrust = z.object({
  reproducedRuns: z.literal(PUBLIC_CASE_RUNS_REPRODUCED_RUNS_VALUES),
  codeEvidence: z.object({
    status: z.enum(["corroborated", "inconclusive"]),
    summary: z.string(),
    commitSha: z.string(),
    files: z.array(z.object({
      path: z.string(),
      lineStart: z.number().nullable(),
      lineEnd: z.number().nullable(),
      rationale: z.string(),
    })),
  }).nullable(),
});

export const caseCompletion = z.object({
  verdict: z.enum(PUBLIC_CASE_RUNS_VERDICT_VALUES),
  summary: z.string(),
  failureReason: z.string().nullable().exactOptional(),
  checklist,
  walk: z.object({ walkMs: z.number(), journeyCaseId: z.string().nullable() }).exactOptional(),
});

export const activityCompletion = z.object({
  status: z.enum(["completed", "needs_attention", "failed", "superseded"]),
  resultKind: z.enum(PUBLIC_ACTIVITY_RESULTS_KIND_VALUES),
  summary: z.string(),
  attentionCode: z.enum(PUBLIC_ACTIVITY_RESULTS_ATTENTION_CODE_VALUES).nullable().exactOptional(),
  recoveryAction: z.string().nullable().exactOptional(),
  proposalIds: z.array(z.string()).exactOptional(),
});

export const knowledgeEntry = z.object({
  entry: knowledgeEntrySchema,
  supersedes: z.string().nullable().exactOptional(),
});

export const agentSession = z.object({
  transcriptFile: z.string(),
  transcript: z.string(),
  journeyStore: z.string().nullable(),
});

const journeyCase = z.object({
  id: z.string().optional(),
  title: z.string(),
  steps: z.union([z.string(), z.array(z.union([z.string(), z.object({ id: z.string(), instruction: z.string() })]))]),
  category: z.string(),
  checkpoints: z.array(z.union([
    z.string(),
    z.object({ id: z.string().exactOptional(), goal: z.string(), afterStep: z.string().nullable().exactOptional() }),
  ])),
  whyItMatters: z.string().nullable().optional(),
  preconditions: z.array(z.string()).readonly().optional(),
  role: z.enum(PUBLIC_SUITE_CASES_ROLE_VALUES).optional(),
  scopeCaseId: z.string().nullable().optional(),
  scopeCandidateIndex: z.number().nullable().optional(),
  repeat: z.enum(PUBLIC_SUITE_CASES_REPEAT_VALUES).optional(),
  ownerConfirmation: z.enum(OWNER_CONFIRMATIONS).optional(),
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const proposal = z.object({
  sourceIndex: z.number(),
  kind: z.enum(PUBLIC_PROPOSALS_KIND_VALUES),
  targetSuiteId: z.string().nullable(),
  baseDefinitionRevision: z.number().nullable(),
  proposedSuiteName: z.string().nullable(),
  productThesis: z.string().nullable().exactOptional(),
  candidateCases: z.array(journeyCase).readonly(),
});

export const expiredSignIn = z.object({
  profileId: z.string(),
  baseStateVersion: z.string().nullable(),
});

export const failedSignIn = expiredSignIn.extend({ reason: z.string() });
