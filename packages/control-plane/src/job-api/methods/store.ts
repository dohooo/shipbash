/**
 * The worker store on the wire: each method's name is its JobStore key and
 * its arguments are the ones after the capability, which the server derives
 * from the job row (job-api/identity.ts), never from the caller. The chat's
 * host methods and the transient-retry handback stay off the wire; the single
 * event appends travel as batches (remote.ts).
 */
import { z } from "zod";

import { SANDBOX_LEASE_SECONDS } from "../../store/dispatch-claims.ts";
import type { JobStore } from "../../store/job-store.ts";
import type { DispatchJobLeaseCapability } from "../../types.ts";
import { defineJobMethod, type JobMethod } from "../define.ts";
import * as input from "./store-schemas.ts";

/** The worker id a Sandbox's executor claims under: one random UUID per executor (vercel-sandbox-task/execute.ts). */
export const SANDBOX_WORKER_ID = /^vercel-sandbox-[0-9a-f-]{36}$/u;

function storeMethod<Args extends unknown[], Input, Result>(
  args: z.ZodType<Args, Input>,
  call: (jobs: JobStore, capability: DispatchJobLeaseCapability, args: NoInfer<Args>) => Promise<Result>,
): JobMethod<Args, Result, Input> {
  return defineJobMethod({ args, run: (context, ...values) => call(context.store.jobs, context.capability, values) });
}

const none = z.tuple([]);
const text = z.string();

export const storeMethods = {
  // The reservation the Sandbox was launched for is the row's lease token.
  claimDispatchJob: defineJobMethod({
    args: z.tuple([z.string().regex(SANDBOX_WORKER_ID)]),
    run: (context, workerId: string) => context.store.jobs.claimReservedDispatchJob({
      jobId: context.job.id, reservation: context.capability.leaseToken, workerId,
    }),
  }),
  heartbeatDispatchJob: storeMethod(z.tuple([z.number().int().optional()]),
    (jobs, capability) => jobs.heartbeatDispatchJob(capability, SANDBOX_LEASE_SECONDS)),
  isDispatchCancellationRequested: storeMethod(none,
    (jobs, capability) => jobs.isDispatchCancellationRequested(capability)),
  loadDispatchExecutionInput: storeMethod(none,
    (jobs, capability) => jobs.loadDispatchExecutionInput(capability)),

  appendRunEventsForJob: storeMethod(z.tuple([z.array(input.runEvent).max(input.MAX_EVENT_BATCH).readonly()]),
    (jobs, capability, [events]) => jobs.appendRunEventsForJob(capability, events)),
  appendActivityEventsForJob: storeMethod(z.tuple([z.array(input.activityEvent).max(input.MAX_EVENT_BATCH).readonly()]),
    (jobs, capability, [events]) => jobs.appendActivityEventsForJob(capability, events)),
  startCaseRunForJob: storeMethod(z.tuple([text, z.number().int().optional()]),
    (jobs, capability, [snapshotCaseId, attempt]) => jobs.startCaseRunForJob(capability, snapshotCaseId, attempt)),
  updateCaseChecklistForJob: storeMethod(z.tuple([text, input.checklist]),
    (jobs, capability, [caseRunId, checklist]) => jobs.updateCaseChecklistForJob(capability, caseRunId, checklist)),
  updateCaseTrustForJob: storeMethod(z.tuple([text, input.caseTrust]),
    (jobs, capability, [caseRunId, trust]) => jobs.updateCaseTrustForJob(capability, caseRunId, trust)),
  completeCaseRunForJob: storeMethod(z.tuple([text, input.caseCompletion]),
    (jobs, capability, [caseRunId, completion]) => jobs.completeCaseRunForJob(capability, caseRunId, completion)),
  completeActivityForJob: storeMethod(z.tuple([input.activityCompletion]),
    (jobs, capability, [completion]) => jobs.completeActivityForJob(capability, completion)),
  createProposalForJob: storeMethod(z.tuple([input.proposal]),
    (jobs, capability, [proposal]) => jobs.createProposalForJob(capability, proposal)),
  recordKnowledgeEntryForJob: storeMethod(z.tuple([input.knowledgeEntry]),
    (jobs, capability, [entry]) => jobs.recordKnowledgeEntryForJob(capability, entry)),
  saveActivityAgentSessionForJob: storeMethod(z.tuple([input.agentSession]),
    (jobs, capability, [session]) => jobs.saveActivityAgentSessionForJob(capability, session)),

  markActivityWaitingForInputForJob: storeMethod(z.tuple([input.activityEvent]),
    (jobs, capability, [question]) => jobs.markActivityWaitingForInputForJob(capability, question)),
  markActivityRunningAfterInputForJob: storeMethod(none,
    (jobs, capability) => jobs.markActivityRunningAfterInputForJob(capability)),
  withdrawActivityQuestionForJob: storeMethod(z.tuple([text]),
    (jobs, capability, [questionId]) => jobs.withdrawActivityQuestionForJob(capability, questionId)),
  withdrawOpenActivityQuestionForJob: storeMethod(none,
    (jobs, capability) => jobs.withdrawOpenActivityQuestionForJob(capability)),
  markActivityInlineAuthWaitingForJob: storeMethod(none,
    (jobs, capability) => jobs.markActivityInlineAuthWaitingForJob(capability)),
  markActivityInlineAuthRunningForJob: storeMethod(none,
    (jobs, capability) => jobs.markActivityInlineAuthRunningForJob(capability)),
  releaseDispatchJobWaitingForAuth: storeMethod(none,
    (jobs, capability) => jobs.releaseDispatchJobWaitingForAuth(capability)),
  markTargetAuthProfileExpiredForJob: storeMethod(z.tuple([input.expiredSignIn]),
    (jobs, capability, [signIn]) => jobs.markTargetAuthProfileExpiredForJob(capability, signIn)),
  markTargetAuthProfileFailedForJob: storeMethod(z.tuple([input.failedSignIn]),
    (jobs, capability, [signIn]) => jobs.markTargetAuthProfileFailedForJob(capability, signIn)),

  markDispatchFinalizationFailed: storeMethod(z.tuple([text]),
    (jobs, capability, [reason]) => jobs.markDispatchFinalizationFailed(capability, reason)),
  completeDispatchJob: storeMethod(z.tuple([text.optional()]),
    (jobs, capability, [hookFailureReason]) => jobs.completeDispatchJob(capability, hookFailureReason)),
  failDispatchJob: storeMethod(z.tuple([text]),
    (jobs, capability, [reason]) => jobs.failDispatchJob(capability, reason)),
  cancelDispatchJob: storeMethod(z.tuple([text.optional()]),
    (jobs, capability, [reason]) => jobs.cancelDispatchJob(capability, reason)),
};
