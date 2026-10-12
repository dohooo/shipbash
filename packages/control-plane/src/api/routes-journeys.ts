/** Journey (suite) listing, editing, scheduling, run-now and case retry. */
import { type CaseRole, hookCategory, isJourneyRole } from "@shipbash/contracts/runtime/case-role-contract.mjs";
import { journeyCaseContentDiffers } from "../journey-edit.ts";
import { assertCronExpression } from "../schedule-cron.ts";
import { normalizeJourneySteps } from "@shipbash/contracts/journey-contracts";
import {
  addJourneyCaseContract,
  archiveJourneyCaseContract,
  getJourneyContract,
  retryJourneyContract,
  runJourneyContract,
  updateJourneyCaseContract,
  updateJourneyScheduleContract,
} from "@shipbash/contracts/api/journeys";
import { stageJourneyEditContract } from "@shipbash/contracts/api/proposals";
import { parseBody, parseParams, parseQuery, sendContractJson } from "./contracts/server.ts";
import { RevisionConflictError } from "../store/revision-conflict.ts";
import { ApiError } from "./http.ts";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { matchRoute } from "./match-route.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { assertProjectAcceptsRuns, projectContext } from "./route-support.ts";
import { dispatchedRunView, loadProposalViewInputs, proposalView, scheduleView, suiteDetailView, suiteNameMap } from "./views.ts";

/** A stored Case as the save takes it back, every field the owner did not touch as it was. */
function storedCaseInput(entry: NonNullable<Awaited<ReturnType<RouteContext["options"]["store"]["getSuiteDetail"]>>>["cases"][number]) {
  return {
    id: entry.id,
    title: entry.title,
    steps: entry.steps,
    category: entry.category,
    checkpoints: entry.checkpoints,
    whyItMatters: entry.whyItMatters,
    preconditions: entry.preconditions,
    role: entry.role,
    scopeCaseId: entry.scopeCaseId,
    repeat: entry.repeat,
    enabled: entry.enabled,
    archived: entry.archivedAt !== null,
  };
}

/**
 * A direct write sends back a case list built from this unlocked read, and the
 * store compares only the caller's revision under its lock. So the read must
 * be at the caller's revision too, or a write that landed in between is undone.
 */
function assertReadAtCallerRevision(detail: { suite: { definitionRevision: number } }, expectedRevision: number): void {
  if (detail.suite.definitionRevision !== expectedRevision) {
    throw new RevisionConflictError(expectedRevision, detail.suite.definitionRevision);
  }
}

/**
 * A Journey's content changes only through a staged edit and the walk that
 * proves it (stage-edit, then edit-run); a direct write serves hooks alone.
 * Removing a Journey stays direct.
 */
function journeyNeedsWalk(message: string): ApiError {
  return new ApiError(409, "JOURNEY_NEEDS_WALK", message);
}

/** A PATCH's slot: refused when the Case is a Journey before the write or would be one after it. */
function patchedHookRole(stored: CaseRole, sent: CaseRole | undefined) {
  const role = sent ?? stored;
  if (isJourneyRole(stored) || isJourneyRole(role)) {
    throw journeyNeedsWalk("Journeys are edited by a walk: describe the change with `journeys edit`.");
  }
  return role;
}

/** The revision the caller read, with a PATCH's fields; a DELETE names only the revision, in its query. */
async function readCaseWrite(request: RouteContext["request"], url: URL) {
  if (request.method !== "PATCH") return { ...parseQuery(archiveJourneyCaseContract.query, url), patch: null };
  const { expectedRevision, ...patch } = await parseBody(request, updateJourneyCaseContract.body);
  return { expectedRevision, patch };
}

/** Saves a direct write of the Suite's Cases, then reads the Suite back as it now stands. */
async function saveSuiteCases(
  context: RouteContext,
  scope: { teamId: string; projectId: string; journeyId: string },
  revision: Parameters<RouteContext["options"]["store"]["saveManualSuiteRevision"]>[4],
) {
  const { actor, options } = context;
  const { teamId, projectId, journeyId } = scope;
  await options.store.saveManualSuiteRevision(actor, teamId, projectId, journeyId, revision);
  const updated = await options.store.getSuiteDetail(actor, teamId, projectId, journeyId);
  if (!updated) throw new ApiError(500, "SUITE_UPDATE_FAILED", "The updated Suite could not be loaded.");
  return updated;
}

async function handleJourneyDetail(context: RouteContext): Promise<boolean> {
  const { response, actor, options } = context;
  const hit = matchRoute(context, getJourneyContract);
  if (!hit) return false;
  const { projectId, journeyId } = parseParams(getJourneyContract.params, hit.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const detail = await options.store.getSuiteDetail(actor, teamId, projectId, journeyId);
  if (!detail) throw new ApiError(404, "SUITE_NOT_FOUND", "Suite was not found.");
  sendContractJson(response, 200, getJourneyContract, suiteDetailView(detail));
  return true;
}

async function handleJourneyCaseCollection(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, addJourneyCaseContract);
  if (!hit) return false;
  const { projectId, journeyId } = parseParams(addJourneyCaseContract.params, hit.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const { expectedRevision, ...added } = await parseBody(request, addJourneyCaseContract.body);
  if (isJourneyRole(added.role)) {
    throw journeyNeedsWalk("Journeys are added by a walk: describe the path with `journeys add`.");
  }
  const detail = await options.store.getSuiteDetail(actor, teamId, projectId, journeyId);
  if (!detail) throw new ApiError(404, "SUITE_NOT_FOUND", "Suite was not found.");
  assertReadAtCallerRevision(detail, expectedRevision);
  const cases = detail.cases.map((entry) => storedCaseInput(entry));
  const updated = await saveSuiteCases(context, { teamId, projectId, journeyId }, {
    expectedRevision,
    name: detail.suite.name,
    cases: [...cases, { ...added, category: hookCategory(added.role), enabled: true, archived: false }],
  });
  sendContractJson(response, 201, addJourneyCaseContract, { suite: suiteDetailView(updated) });
  return true;
}

async function handleJourneyCase(context: RouteContext): Promise<boolean> {
  const { url, request, response, actor, options } = context;
  const hit = matchRoute(context, updateJourneyCaseContract, archiveJourneyCaseContract);
  if (!hit) return false;
  const { projectId, journeyId, caseId } = parseParams(hit.route.params, hit.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const detail = await options.store.getSuiteDetail(actor, teamId, projectId, journeyId);
  if (!detail) throw new ApiError(404, "SUITE_NOT_FOUND", "Suite was not found.");
  const target = detail.cases.find((entry) => entry.id === caseId);
  if (!target) throw new ApiError(404, "CASE_NOT_FOUND", "Case was not found.");
  const { expectedRevision, patch } = await readCaseWrite(request, url);
  const hook = patch && { ...patch, role: patchedHookRole(target.role, patch.role) };
  assertReadAtCallerRevision(detail, expectedRevision);
  const cases = detail.cases.map((entry) => {
    const current = storedCaseInput(entry);
    if (entry.id !== caseId) return current;
    if (!hook) return { ...current, archived: true };
    return {
      ...current,
      ...hook,
      // The path parameter names the case; a smuggled body id must not rename it.
      id: entry.id,
      // Merge-patch semantics: an explicit null clears; an absent key keeps the stored value.
      whyItMatters: "whyItMatters" in hook ? hook.whyItMatters ?? null : entry.whyItMatters,
      preconditions: hook.preconditions ?? entry.preconditions,
      category: hookCategory(hook.role),
      scopeCaseId: "scopeCaseId" in hook ? hook.scopeCaseId ?? null : entry.scopeCaseId,
      repeat: hook.repeat ?? entry.repeat,
    };
  });
  const updated = await saveSuiteCases(context, { teamId, projectId, journeyId }, {
    expectedRevision,
    name: detail.suite.name,
    cases,
  });
  const payload = { suite: suiteDetailView(updated) };
  if (request.method === "PATCH") sendContractJson(response, 200, updateJourneyCaseContract, payload);
  else sendContractJson(response, 200, archiveJourneyCaseContract, payload);
  return true;
}

async function handleStageJourneyEdit(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, stageJourneyEditContract);
  if (!hit) return false;
  const { projectId, journeyId, caseId } = parseParams(stageJourneyEditContract.params, hit.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const body = await parseBody(request, stageJourneyEditContract.body);
  const detail = await options.store.getSuiteDetail(actor, teamId, projectId, journeyId);
  if (!detail) throw new ApiError(404, "SUITE_NOT_FOUND", "Suite was not found.");
  const live = detail.cases.find((entry) => entry.id === caseId);
  if (!live) throw new ApiError(404, "CASE_NOT_FOUND", "Case was not found.");
  if (!body.instruction.trim() && !journeyCaseContentDiffers(live, {
    title: body.case.title,
    category: body.case.category,
    whyItMatters: body.case.whyItMatters ?? null,
    // The schema lets prose steps through untouched; canonicalize for the diff.
    steps: typeof body.case.steps === "string" ? normalizeJourneySteps(body.case.steps) : body.case.steps,
    checkpoints: body.case.checkpoints,
  })) {
    throw new ApiError(400, "NOTHING_TO_STAGE", "Change a field or add an instruction before staging.");
  }
  const proposal = await options.store.stageJourneyEdit(actor, teamId, projectId, journeyId, caseId, {
    instruction: body.instruction,
    case: body.case,
    expectedRevision: body.expectedRevision,
  });
  sendContractJson(response, 200, stageJourneyEditContract, {
    proposal: proposalView(proposal, await loadProposalViewInputs(options.store, actor, teamId, projectId, [proposal])),
  });
  return true;
}

async function handleRunJourney(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, runJourneyContract);
  if (!hit) return false;
  const { projectId, journeyId } = parseParams(runJourneyContract.params, hit.raw);
  const { project, teamId } = await projectContext(options.store, actor, projectId);
  assertProjectAcceptsRuns(project);
  const { clientIdempotencyKey } = await parseBody(request, runJourneyContract.body);
  const dispatch = await options.store.runSuiteNow(
    actor,
    teamId,
    projectId,
    journeyId,
    dispatchIdentity(teamId, projectId, "run-suite", clientIdempotencyKey),
  );
  await options.onWorkAvailable?.();
  const suiteNames = suiteNameMap(await options.store.listSuiteSummaries(actor, teamId, projectId));
  sendContractJson(response, dispatch.created ? 201 : 200, runJourneyContract, {
    run: dispatchedRunView(dispatch.run, suiteNames), dispatch,
  });
  return true;
}

async function handleRetryJourney(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, retryJourneyContract);
  if (!hit) return false;
  const { projectId, runId, caseRunId } = parseParams(retryJourneyContract.params, hit.raw);
  const { project, teamId } = await projectContext(options.store, actor, projectId);
  assertProjectAcceptsRuns(project);
  const { clientIdempotencyKey } = await parseBody(request, retryJourneyContract.body);
  const dispatch = await options.store.retryCaseRun(
    actor,
    teamId,
    projectId,
    caseRunId,
    dispatchIdentity(teamId, projectId, "retry-case", clientIdempotencyKey),
    runId,
  );
  await options.onWorkAvailable?.();
  const suiteNames = suiteNameMap(await options.store.listSuiteSummaries(actor, teamId, projectId));
  sendContractJson(response, dispatch.created ? 201 : 200, retryJourneyContract, {
    run: dispatchedRunView(dispatch.run, suiteNames), dispatch,
  });
  return true;
}

async function handleJourneySchedule(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, updateJourneyScheduleContract);
  if (!hit) return false;
  const { projectId, journeyId } = parseParams(updateJourneyScheduleContract.params, hit.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const body = await parseBody(request, updateJourneyScheduleContract.body);
  if (body.cadence === "cron") {
    try {
      assertCronExpression(body.cronExpression ?? "", body.timezone ?? "");
    } catch (error) {
      throw new ApiError(400, "INVALID_SCHEDULE", error instanceof Error
        ? error.message : "Cron expression is not valid.");
    }
  }
  const schedule = await options.store.upsertSuiteSchedule(actor, teamId, projectId, journeyId, body);
  const view = scheduleView(schedule);
  if (!view) throw new ApiError(500, "SCHEDULE_UPDATE_FAILED", "The updated Schedule could not be loaded.");
  sendContractJson(response, 200, updateJourneyScheduleContract, { schedule: view });
  return true;
}

export const handleJourneys = firstHandled(
  handleJourneyDetail,
  handleJourneyCaseCollection,
  handleJourneyCase,
  handleStageJourneyEdit,
  handleRunJourney,
  handleRetryJourney,
  handleJourneySchedule,
);
