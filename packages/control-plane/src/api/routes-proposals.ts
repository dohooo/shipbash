/**
 * Proposal decisions and detail; walks from a proposal are in
 * routes-proposal-walks.ts. A proposal's drafts are kept or discarded as
 * their walk delivered them: nothing here edits one.
 */
import {
  acceptProposalContract,
  getProposalContract,
  rejectProposalContract,
} from "@shipbash/contracts/api/proposals";
import { parseBody, parseParams, sendContractJson } from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError } from "./http.ts";
import type { StoreProposal } from "./gateways.ts";
import { readProposal, refuseEditWalkResult } from "./proposal-guards.ts";
import { type KeepScope, keepDraftsAndVerify } from "./proposal-keep.ts";
import { proposalWalkHandlers } from "./routes-proposal-walks.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext } from "./route-support.ts";
import { loadProposalViewInputs, proposalView, runView } from "./views.ts";

type ProposalScope = { teamId: string; projectId: string };
type AcceptDecision = { expectedUpdatedAt: string; walkId?: string | undefined; keep?: string[] | undefined };

function proposalViewContext(context: RouteContext, scope: ProposalScope, proposals: readonly StoreProposal[]) {
  return loadProposalViewInputs(context.options.store, context.actor, scope.teamId, scope.projectId, proposals);
}

async function handleRejectProposal(context: RouteContext): Promise<boolean> {
  const { request, response, actor, options } = context;
  const hit = matchRoute(context, rejectProposalContract);
  if (!hit) return false;
  const { projectId, proposalId } = parseParams(rejectProposalContract.params, hit.raw);
  await parseBody(request, rejectProposalContract.body);
  const { teamId } = await projectContext(options.store, actor, projectId);
  refuseEditWalkResult(await readProposal(context, { teamId, projectId }, proposalId));
  const rejected = await options.store.rejectProposal(actor, teamId, projectId, proposalId);
  const view = await proposalViewContext(context, { teamId, projectId }, [rejected]);
  sendContractJson(response, 200, rejectProposalContract, {
    proposal: proposalView(rejected, view),
    suiteId: null,
  });
  return true;
}

/** Keeping a staging draft: the server applies what the reviewed walk proved and retires the draft. */
async function keepStagedEdits(
  context: RouteContext,
  scope: ProposalScope,
  draftId: string,
  decision: AcceptDecision,
): Promise<true> {
  const { walkId } = decision;
  if (!walkId) throw new ApiError(400, "WALK_REQUIRED", "Name the walk you reviewed to keep staged edits.");
  const kept = await context.options.store.keepJourneyEdit(context.actor, scope.teamId, scope.projectId, draftId, {
    walkId,
    expectedUpdatedAt: decision.expectedUpdatedAt,
  });
  const view = await proposalViewContext(context, scope, [kept.proposal]);
  sendContractJson(context.response, 200, acceptProposalContract, {
    proposal: proposalView(kept.proposal, view),
    suiteId: kept.suiteId,
    outcome: kept.outcome,
    kept: kept.kept,
  });
  return true;
}

/**
 * Keeping a walk's drafts: the ones the reader kept land as the walk
 * delivered them (the store decides which, on the locked proposal), then
 * what landed is verified. An initial discovery's list lands as the
 * project's first confirmation and its run.
 */
async function keepDrafts(
  context: RouteContext,
  scope: KeepScope,
  proposalId: string,
  decision: AcceptDecision,
): Promise<true> {
  const { actor, options, response } = context;
  const { kept, ...verified } = await keepDraftsAndVerify(options, actor, scope, proposalId, {
    expectedUpdatedAt: decision.expectedUpdatedAt,
    keep: decision.keep ?? null,
  });
  const accepted = await readProposal(context, scope, proposalId);
  const view = await proposalViewContext(context, scope, [accepted]);
  sendContractJson(response, verified.run?.created ? 201 : 200, acceptProposalContract, {
    proposal: proposalView(accepted, view),
    suiteId: kept.suiteId,
    outcome: kept.outcome,
    kept: kept.kept,
    run: verified.run ? runView(verified.run.run, view.suiteNames) : null,
    ...(verified.refusal ? { runRefusal: verified.refusal } : {}),
  });
  return true;
}

async function handleAcceptProposal(context: RouteContext): Promise<boolean> {
  const { request, actor, options } = context;
  const hit = matchRoute(context, acceptProposalContract);
  if (!hit) return false;
  const { projectId, proposalId } = parseParams(acceptProposalContract.params, hit.raw);
  const decision = await parseBody(request, acceptProposalContract.body);
  const { project, teamId } = await projectContext(options.store, actor, projectId);
  const candidate = await readProposal(context, { teamId, projectId }, proposalId);
  if (candidate.journeyEditInstructions) return keepStagedEdits(context, { teamId, projectId }, proposalId, decision);
  refuseEditWalkResult(candidate);
  return keepDrafts(context, { teamId, projectId, project }, proposalId, decision);
}

async function handleGetProposal(context: RouteContext): Promise<boolean> {
  const { response, actor, options } = context;
  const hit = matchRoute(context, getProposalContract);
  if (!hit) return false;
  const { projectId, proposalId } = parseParams(getProposalContract.params, hit.raw);
  const { teamId } = await projectContext(options.store, actor, projectId);
  const proposal = await options.store.getProposal(actor, teamId, projectId, proposalId);
  if (!proposal) throw new ApiError(404, "PROPOSAL_NOT_FOUND", "Proposal was not found.");
  const view = await proposalViewContext(context, { teamId, projectId }, [proposal]);
  sendContractJson(response, 200, getProposalContract, proposalView(proposal, view));
  return true;
}

export const handleProposals = firstHandled(
  handleRejectProposal,
  handleAcceptProposal,
  handleGetProposal,
  ...proposalWalkHandlers,
);
