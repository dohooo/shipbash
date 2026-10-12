import { followUpProposalContract, startJourneyEditRunContract } from "@shipbash/contracts/api/activities";
import {
  addJourneyCaseContract,
  archiveJourneyCaseContract,
  retryJourneyContract,
  runJourneyContract,
  updateJourneyCaseContract,
  updateJourneyScheduleContract,
} from "@shipbash/contracts/api/journeys";
import {
  acceptProposalContract,
  rejectProposalContract,
  stageJourneyEditContract,
} from "@shipbash/contracts/api/proposals";
import { callApi } from "./api-client";
import type {
  ProposalCase,
  Schedule,
} from "./web-client-types";

export const journeysClient = {
  addCase: (
    projectId: string,
    journeyId: string,
    input: Pick<ProposalCase, "title" | "steps" | "checkpoints" | "scopeCaseId" | "repeat">
      & { role: NonNullable<ProposalCase["role"]>; expectedRevision: number },
  ) => callApi(addJourneyCaseContract, { params: { projectId, journeyId }, body: input }),
  updateCase: (
    projectId: string,
    journeyId: string,
    caseId: string,
    input: Pick<
      ProposalCase,
      "title" | "steps" | "checkpoints" | "whyItMatters" | "role" | "scopeCaseId" | "repeat"
    > & { enabled: boolean; preconditions?: readonly string[]; expectedRevision: number },
  ) => {
    const { preconditions, ...body } = input;
    return callApi(updateJourneyCaseContract, {
      params: { projectId, journeyId, caseId },
      body: {
        ...body,
        ...(preconditions ? { preconditions: [...preconditions] } : {}),
      },
    });
  },
  stageJourneyEdit: (
    projectId: string,
    journeyId: string,
    caseId: string,
    input: {
      instruction: string;
      case: Pick<
        ProposalCase,
        "title" | "steps" | "category" | "checkpoints" | "whyItMatters"
      > & { enabled: boolean };
      expectedRevision: number;
    },
  ) => callApi(stageJourneyEditContract, {
    params: { projectId, journeyId, caseId },
    body: input,
  }),
  archiveCase: (projectId: string, journeyId: string, caseId: string, expectedRevision: number) => callApi(
    archiveJourneyCaseContract,
    { params: { projectId, journeyId, caseId }, query: { expectedRevision } },
  ),
  runSuite: (projectId: string, journeyId: string, clientIdempotencyKey: string) => callApi(runJourneyContract, {
    params: { projectId, journeyId },
    body: { clientIdempotencyKey },
  }),
  runJourney: (projectId: string, runId: string, caseRunId: string, clientIdempotencyKey: string) => callApi(
    retryJourneyContract,
    {
      params: { projectId, runId, caseRunId },
      body: { clientIdempotencyKey },
    },
  ),
  updateSchedule: (
    projectId: string,
    journeyId: string,
    input: Pick<Schedule, "cadence" | "localTime" | "cronExpression" | "timezone">,
  ) => callApi(updateJourneyScheduleContract, { params: { projectId, journeyId }, body: input }),
  acceptProposal: (
    projectId: string,
    proposalId: string,
    input: { expectedUpdatedAt: string; walkId?: string; keep?: string[] },
  ) => callApi(
    acceptProposalContract,
    { params: { projectId, proposalId }, body: input },
  ),
  /** Asks for changes to a proposal's drafts; the answer names the walk that takes them. */
  followUpProposal: (
    projectId: string,
    proposalId: string,
    input: { instruction: string; clientIdempotencyKey: string },
  ) => callApi(followUpProposalContract, { params: { projectId, proposalId }, body: input }),
  rejectProposal: (projectId: string, proposalId: string) => callApi(
    rejectProposalContract,
    { params: { projectId, proposalId }, body: {} },
  ),
  startJourneyEditRun: (
    projectId: string,
    proposalId: string,
    clientIdempotencyKey: string,
  ) => callApi(startJourneyEditRunContract, {
    params: { projectId, proposalId },
    body: { clientIdempotencyKey },
  }),
};
