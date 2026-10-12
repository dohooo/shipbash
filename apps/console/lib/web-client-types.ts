import type { sessionContract } from "@shipbash/contracts/api/account";
import type {
	activityEventViewSchema,
	getActivityContract,
} from "@shipbash/contracts/api/activities";
import type {
	journeyCaseSchema,
	journeyDetailSchema,
	runViewSchema,
	scheduleSchema,
} from "@shipbash/contracts/api/journeys";
import type {
	githubRepositoriesContract,
	teamGitHubConnectionsContract,
} from "@shipbash/contracts/api/github";
import type {
	agentRuntimeSchema,
	caseResultSchema,
	journeyCheckpointSchema,
	journeyStepSchema,
	mutableJourneyCaseSchema,
} from "@shipbash/contracts/api/primitives";
import type { projectViewSchema } from "@shipbash/contracts/api/projects";
import type {
	slackChannelsContract,
	teamSlackConnectionsContract,
} from "@shipbash/contracts/api/slack";
import type { proposalViewSchema } from "@shipbash/contracts/api/proposals";
import type { activityEventFrameSchema } from "@shipbash/contracts/api/streams";
import type { boundSignInViewSchema, teamSignInViewSchema } from "@shipbash/contracts/api/sign-ins";
import type { trustedAccessViewSchema } from "@shipbash/contracts/api/trusted-access";
import type { z } from "zod";

export type AgentRuntime = z.output<typeof agentRuntimeSchema>;
export type Session = z.output<typeof sessionContract.response>;
export type Team = Session["teams"][number];
export type TeamRole = Team["role"];
export type Project = z.output<typeof projectViewSchema>;
export type RunSummary = z.output<typeof runViewSchema>;
export type CaseResult = z.output<typeof caseResultSchema>;
export type CaseSummary = z.output<typeof journeyCaseSchema>;
export type Schedule = z.output<typeof scheduleSchema>;
export type SuiteDetail = z.output<typeof journeyDetailSchema>;
export type Proposal = z.output<typeof proposalViewSchema>;
export type ProposalCase = z.input<typeof mutableJourneyCaseSchema>;
export type ActivityDetail = z.output<typeof getActivityContract.response>;
export type ActivityEvent = z.output<typeof activityEventViewSchema>;
export type ActivityStreamEvent = z.output<typeof activityEventFrameSchema>;
export type TrustedAccess = z.output<typeof trustedAccessViewSchema>;
export type TeamSignIn = z.output<typeof teamSignInViewSchema>;
/** A way in as the Project that bound it sees it: whether its verification runs sign in with it, too. */
export type BoundSignIn = z.output<typeof boundSignInViewSchema>;
export type TeamSignInMethod = TeamSignIn["method"];
type SlackConnections = z.output<typeof teamSlackConnectionsContract.response>;
export type SlackWorkspace = SlackConnections["workspaces"][number];
export type SlackPendingInstall = NonNullable<SlackConnections["pendingInstall"]>;
export type SlackChannelBinding = SlackWorkspace["bindings"][number];
export type SlackDeliveryError = NonNullable<SlackChannelBinding["deliveryError"]>;
export type SlackChannel =
	z.output<typeof slackChannelsContract.response>["channels"][number];
export type GitHubConnection = z.output<typeof teamGitHubConnectionsContract.response>["connections"][number];
export type GitHubBinding = GitHubConnection["bindings"][number];
export type GitHubRepository =
	z.output<typeof githubRepositoriesContract.response>["repositories"][number];
export type JourneyStep = z.output<typeof journeyStepSchema>;
export type JourneyStepInput = string | { instruction: string };
export type JourneyCheckpoint = z.output<typeof journeyCheckpointSchema>;
export type JourneyCheckpointInput = string | { goal: string };
