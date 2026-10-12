/**
 * Walks started from a proposal, each naming it and started under its lock:
 * a follow-up revises a proposal's drafts, and edit-run walks a journey-edit
 * staging draft. Drafts change only through a walk: a follow-up always
 * starts a new one, whose delivery supersedes the drafts it revised. Staged
 * edits are walked only by edit-run.
 */
import { followUpProposalContract, startJourneyEditRunContract } from "@shipbash/contracts/api/activities";
import { modelContractFor } from "@shipbash/contracts/model-contract";
import { PROMPT_CONTRACTS } from "@shipbash/contracts/prompt-contracts";
import { followUpBrief } from "../draft-review.ts";
import { composeJourneyEditInstruction } from "../journey-edit.ts";
import { editRunActivity } from "../journey-edit-run.ts";
import { carriedRepository } from "../store/project-repositories.ts";
import { parseBody, parseParams, sendContractJson } from "./contracts/server.ts";
import type { StoreProposal } from "./gateways.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError } from "./http.ts";
import { dispatchIdentity } from "../dispatch-identity.ts";
import { readProposal, refuseEditWalkResult } from "./proposal-guards.ts";
import type { RouteContext } from "./route-support.ts";
import { assertProjectAcceptsRuns, projectContext } from "./route-support.ts";
import { activityView, liveCaseIds, loadProposalViewInputs, type ProposalViewInputs, unchangedCaseIds } from "./views.ts";

/**
 * The walk that revises a proposal's drafts: a Discovery's list is continued
 * by a Discovery that starts from it (its lineage seeds the Journey list,
 * so the change is its brief), any other proposal by a walk of its target
 * Suite, given a system brief with the drafts it revises; the reader's bubble
 * shows their own words.
 */
function followUpWalk(source: StoreProposal, view: ProposalViewInputs, change: string) {
  return view.initialIds.has(source.id) && source.sourceActivityId
    ? {
        kind: "initial_discovery" as const,
        continues: source.sourceActivityId,
        opening: { message: change },
        promptContractVersion: PROMPT_CONTRACTS.initial_discovery.version,
        modelContract: modelContractFor("discovery"),
        protectedInput: JSON.stringify({ targetSuiteId: null }),
      }
    : {
        kind: "generate_cases" as const,
        continues: null,
        opening: { message: followUpBrief(source, unchangedCaseIds(source, view), liveCaseIds(source, view), change), displayText: change },
        promptContractVersion: PROMPT_CONTRACTS.suite_maintainer.version,
        modelContract: modelContractFor("maintenance"),
        protectedInput: JSON.stringify({ targetSuiteId: source.targetSuiteId }),
      };
}

async function handleProposalFollowUp(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, followUpProposalContract);
  if (!hit) return false;
  const { projectId, proposalId } = parseParams(followUpProposalContract.params, hit.raw);
  const body = await parseBody(request, followUpProposalContract.body);
  const { project, teamId } = await projectContext(options.store, actor, projectId);
  assertProjectAcceptsRuns(project);
  const source = await readProposal(context, { teamId, projectId }, proposalId);
  refuseEditWalkResult(source);
  if (source.journeyEditInstructions) {
    throw new ApiError(409, "EDIT_RUN_REQUIRED", "Staged edits are walked by an edit run, not a follow-up.");
  }
  const view = await loadProposalViewInputs(options.store, actor, teamId, projectId, [source]);
  const { continues, opening, ...walk } = followUpWalk(source, view, body.instruction);
  const checkout = carriedRepository(await options.store.getProjectRepository(actor, teamId, projectId));
  const identity = dispatchIdentity(teamId, projectId, "proposal-follow-up", body.clientIdempotencyKey);
  const activity = await options.store.startFollowUpWalk(actor, teamId, projectId, proposalId, {
    continues,
    activity: {
      ...walk,
      initialMessage: { ...opening, clientKey: `init:${body.clientIdempotencyKey}` },
      triggerSource: "web",
      clientIdempotencyKey: body.clientIdempotencyKey,
      ...checkout,
      dispatchIdentity: { identityHash: identity.identityHash, expiresAt: identity.expiresAt },
    },
  });
  await options.onWorkAvailable?.();
  sendContractJson(response, 201, followUpProposalContract, { activity: activityView(activity) });
  return true;
}

async function handleJourneyEditRun(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, startJourneyEditRunContract);
  if (!hit) return false;
  const { projectId, proposalId } = parseParams(startJourneyEditRunContract.params, hit.raw);
  const body = await parseBody(request, startJourneyEditRunContract.body);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const source = await readProposal(context, { teamId, projectId }, proposalId);
  const instructions = source.journeyEditInstructions ?? null;
  if (source.status !== "draft" || !instructions || !source.targetSuiteId) {
    throw new ApiError(409, "EDIT_RUN_NOT_STAGED", "Stage a journey edit before starting an edit run.");
  }
  const suite = await options.store.getSuiteDetail(actor, teamId, projectId, source.targetSuiteId);
  if (!suite) throw new ApiError(404, "SUITE_NOT_FOUND", "Suite was not found.");
  const checkout = carriedRepository(await options.store.getProjectRepository(actor, teamId, projectId));
  const { instruction, stagedIds } = composeJourneyEditInstruction({
    liveCases: suite.cases.map((entry) => ({ ...entry, archived: entry.archivedAt !== null })),
    candidateCases: source.candidateDefinition,
    instructions,
  });
  if (stagedIds.length === 0) {
    throw new ApiError(409, "EDIT_RUN_NOT_STAGED", "Stage a journey edit before starting an edit run.");
  }
  const identity = dispatchIdentity(
    teamId,
    projectId,
    "journey-edit-run",
    body.clientIdempotencyKey,
  );
  // The brief was composed from the draft as read above; the walk starts only
  // if the draft is still that version.
  const activity = await options.store.startEditWalk(actor, teamId, projectId, proposalId, {
    expectedUpdatedAt: source.updatedAt,
    activity: editRunActivity({
      instruction,
      targetSuiteId: source.targetSuiteId,
      key: body.clientIdempotencyKey,
      triggerSource: "web",
      repository: checkout,
      dispatch: { identityHash: identity.identityHash, expiresAt: identity.expiresAt },
      recordScreen: false,
    }),
  });
  await options.onWorkAvailable?.();
  sendContractJson(response, 201, startJourneyEditRunContract, { activity: activityView(activity) });
  return true;
}

export const proposalWalkHandlers = [handleProposalFollowUp, handleJourneyEditRun];
