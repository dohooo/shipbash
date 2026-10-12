import { sessionContract, teamMembersContract, teamRunAllowanceContract, teamRunDaysContract } from "@shipbash/contracts/api/account";
import { authStatusContract } from "@shipbash/contracts/api/auth";
import { authAttentionContract, readGitHubAuthenticatorContract } from "@shipbash/contracts/api/authenticators";
import { getActivityContract } from "@shipbash/contracts/api/activities";
import { githubRepositoriesContract, teamGitHubConnectionsContract } from "@shipbash/contracts/api/github";
import { getJourneyContract } from "@shipbash/contracts/api/journeys";
import {
  projectActivitiesContract,
  projectJourneysContract,
  projectOverviewContract,
  projectProposalsContract,
  projectVerificationsContract,
} from "@shipbash/contracts/api/projects";
import { getProposalContract } from "@shipbash/contracts/api/proposals";
import {
  getPublicVerificationContract,
  getPublicVerificationEventsContract,
  getVerificationShareContract,
} from "@shipbash/contracts/api/public-verifications";
import { getVerificationContract } from "@shipbash/contracts/api/runs";
import { getVerificationLogContract } from "@shipbash/contracts/api/streams";
import { readSignInVerificationContract } from "@shipbash/contracts/api/sign-in-verification";
import { projectSignInsContract, teamSignInsContract } from "@shipbash/contracts/api/sign-ins";
import { slackChannelsContract, teamSlackConnectionsContract } from "@shipbash/contracts/api/slack";
import { getTrustedAccessContract } from "@shipbash/contracts/api/trusted-access";
import type { ApiRead } from "./api-client";

/**
 * The reads a page can have the server make before it renders, over either
 * transport: `webClient` carries them over `fetch`, and the server's copy reads
 * in process with the reader's cookies. One definition, so the two can only
 * ever ask for the same thing — and each read's name, followed by its
 * arguments, is its cache key (`readKey`), so a name here is also a key root.
 * No read here starts or commits anything on the reader's behalf (one records
 * what Slack answered), and both transports answer every one.
 */
export function apiReads(read: ApiRead) {
  return {
    session: (teamId: string | null) => read(sessionContract, { query: { team: teamId ?? undefined } }),
    team: (teamId: string) => read(teamMembersContract, { params: { teamId } }),
    /** The Runs the team has used this month, against its quota. */
    runAllowance: (teamId: string) => read(teamRunAllowanceContract, { params: { teamId } }),
    /** The team's Runs per UTC day and project, over the year the Usage pane draws. */
    runDays: (teamId: string) => read(teamRunDaysContract, { params: { teamId } }),
    slackConnections: (teamId: string) => read(teamSlackConnectionsContract, { params: { teamId } }),
    githubConnections: (teamId: string) => read(teamGitHubConnectionsContract, { params: { teamId } }),
    githubRepositories: (teamId: string, connectionId: string) => read(githubRepositoriesContract, {
      params: { teamId, connectionId },
    }),
    slackChannels: (teamId: string, workspaceId: string) => read(slackChannelsContract, {
      params: { teamId, workspaceId },
    }),
    teamSignIns: (teamId: string) => read(teamSignInsContract, { params: { teamId } }),
    overview: (projectId: string) => read(projectOverviewContract, { params: { projectId } }),
    journeys: (projectId: string) => read(projectJourneysContract, { params: { projectId } }),
    activities: (projectId: string) => read(projectActivitiesContract, { params: { projectId } }),
    proposals: (projectId: string) => read(projectProposalsContract, { params: { projectId } }),
    verifications: (projectId: string) => read(projectVerificationsContract, { params: { projectId } }),
    projectSignIns: (projectId: string) => read(projectSignInsContract, { params: { projectId } }),
    readGitHubAuthenticator: (projectId: string, signInId: string) => read(readGitHubAuthenticatorContract, {
      params: { projectId, signInId },
    }),
    /** What waits on the owner's sign-in, across the project or for one run. */
    authAttention: (projectId: string, runId?: string) => read(authAttentionContract, {
      params: { projectId },
      query: runId ? { runId } : {},
    }),
    trustedAccess: (projectId: string) => read(getTrustedAccessContract, { params: { projectId } }),
    journey: (projectId: string, journeyId: string) => read(getJourneyContract, { params: { projectId, journeyId } }),
    activity: (projectId: string, activityId: string) => read(getActivityContract, {
      params: { projectId, activityId },
    }),
    proposal: (projectId: string, proposalId: string) => read(getProposalContract, {
      params: { projectId, proposalId },
    }),
    /** A run's page, at its latest attempts or at the one walk `attempt` names. */
    verification: (projectId: string, runId: string, attempt?: string | null) => read(getVerificationContract, {
      params: { projectId, runId },
      query: { attempt: attempt ?? undefined },
    }),
    /** The log of `eventsRunId`, the run the page names, after `after`; read through `verificationLog`, which keeps it as one log. */
    verificationLog: (projectId: string, runId: string, eventsRunId: string, after: number) => read(getVerificationLogContract, {
      params: { projectId, runId },
      query: { run: eventsRunId, after },
    }),
    verificationShare: (projectId: string, runId: string) => read(getVerificationShareContract, {
      params: { projectId, runId },
    }),
    /** A run its owner published, read as the anonymous stranger its link reaches. */
    publicVerification: (token: string) => read(getPublicVerificationContract, { params: { token } }),
    /** One page of the log of `runId`, a shared run's `eventsRunId`; read through `publicEventLog`, which keeps them as one log. */
    publicEvents: (token: string, runId: string, after: number) => read(getPublicVerificationEventsContract, {
      params: { token },
      query: { run: runId, after },
    }),
  };
}

/**
 * GETs only the browser makes, keyed like the reads above. Each does something
 * besides answering — the two auth statuses start the sign-in session they
 * report on, `readSignInVerification` settles a check nobody is running any
 * more. A page polls them; a server render must never make them, which is why
 * `serverReadQuery` is built over `apiReads` alone.
 */
export function browserReads(read: ApiRead) {
  return {
    readSignInVerification: (projectId: string, signInId: string) => read(readSignInVerificationContract, {
      params: { projectId, signInId },
    }),
    /** The private browser an Activity waits on while the owner signs in. */
    activityAuthStatus: (projectId: string, activityId: string) => read(authStatusContract, {
      params: { projectId, targetCollection: "activities", targetId: activityId },
    }),
    /** The private browser a run waits on while the owner signs in. */
    verificationAuthStatus: (projectId: string, runId: string) => read(authStatusContract, {
      params: { projectId, targetCollection: "verifications", targetId: runId },
    }),
  };
}

export type ApiReads = ReturnType<typeof apiReads>;
export type BrowserReads = ReturnType<typeof browserReads>;
