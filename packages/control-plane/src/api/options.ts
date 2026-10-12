/** Everything the authenticated API is wired with: the store facets it reads and writes, and the optional gateways. */
import type { WorkProgress } from "../dispatch-worker-types.ts";
import type { GithubAuthenticatorGateway } from "../service/github-authenticator.ts";
import type { ActorStore } from "../store/actor-store.ts";
import type { CliStore } from "../store/cli-store.ts";
import type { InternalStore } from "../store/internal-store.ts";
import type { TrustedAccessVerificationInput } from "../trusted-access-runtime.ts";
import type {
	ArtifactGateway,
	BrowserRecordingGateway,
	GitHubGateway,
	HumanAuthGateway,
	SignInTakeoverGateway,
	SignInVerificationGateway,
	SlackGateway,
	WaitlistMailer,
} from "./gateways.ts";

export interface ApiOptions {
	authenticators?: GithubAuthenticatorGateway;
	store: Pick<
		ActorStore,
		| "bindProjectSignIn"
		| "bootstrapCurrentUser"
		| "readCurrentUser"
		| "acceptInvitation"
		| "cancelActivity"
		| "createActivity"
		| "createInvitation"
		| "archiveProject"
		| "createUrlProject"
		| "createTeamSignIn"
		| "keepDrafts"
		| "verifyKeptDrafts"
		| "startFollowUpWalk"
		| "getActivityDetail"
		| "getActivityStatus"
		| "getActivityStreamTick"
		| "getOverviewAggregate"
		| "getProjectRepository"
		| "getProjectTrustedAccess"
		| "getProposal"
		| "getSuiteRunDetail"
		| "getCaseRunPage"
		| "getActivityPage"
		| "listCaseRunArtifacts"
		| "getSuiteRunLog"
		| "getSuiteRunStatus"
		| "getSuiteRunStreamTick"
		| "getSuiteRunStreamState"
		| "getSuiteRunShare"
		| "getSuiteDetail"
		| "listActivities"
		| "listInitialProposalIds"
		| "keepJourneyEdit"
		| "latestEditWalks"
		| "startEditWalk"
		| "listProjects"
		| "listProjectSignIns"
		| "listProjectRepositories"
		| "listProposals"
		| "listSuiteRuns"
		| "listSuiteSummaries"
		| "listTeamAccessRequests"
		| "listTeamInvitations"
		| "listTeamMembers"
		| "listTeams"
		| "listTeamSignIns"
		| "listSlackConnections"
		| "abandonSlackInstall"
		| "unbindSlackChannel"
		| "linkSlackUser"
		| "readSlackSignIn"
		| "getProject"
		| "getProjectAuthProfile"
		| "reapStrandedSignIns"
		| "recordTeamSignInEvent"
		| "rejectProposal"
		| "removeTeamMember"
		| "rerunHistoricalSuiteRun"
		| "retryActivity"
		| "retryCaseRun"
		| "answerActivityQuestion"
		| "pendingActivityQuestion"
		| "unansweredActivityQuestion"
		| "requestActivityWrapUp"
		| "steerActivity"
		| "requestSuiteRunCancellation"
		| "readRunAllowance"
		| "readRunDays"
		| "readTeamAccessGate"
		| "requestTeamAccess"
		| "resolveTeamAccessRequest"
		| "revokeInvitation"
		| "revokeProjectTrustedAccess"
		| "revokeTeamSignIn"
		| "runSuiteNow"
		| "saveManualSuiteRevision"
		| "setSuiteRunShare"
		| "stageJourneyEdit"
		| "setTeamMemberRole"
		| "unbindProjectSignIn"
		| "updateProject"
		| "updateProjectTrustedAccessVerification"
		| "updateTeamSignIn"
		| "updateProfileDisplayName"
		| "readWaitlistStanding"
		| "joinWaitlist"
		| "upsertSuiteSchedule"
		| "upsertProjectTrustedAccess"
	>;
	/**
	 * The API's doors outside the actor surface. The trusted-access header
	 * never rides RLS; the waiting list's internal lane has no account behind
	 * it at all. These arrive through the internal facet — named separately to
	 * keep the actor store free of unauthenticated doors.
	 */
	internal: Pick<
		InternalStore,
		| "admitWaitlistRequest"
		| "listTeamUsage"
		| "listWaitlistRequests"
		| "openProjectTrustedAccessInternal"
		| "setTeamRunQuota"
		| "setWaitlistShelved"
	>;
	actorSigningSecret: string;
	/** The public CLI's sign-in store; absent where the CLI cannot sign in. */
	cli?: Pick<
		CliStore,
		| "createLoginRequest"
		| "collectToken"
		| "readLoginRequest"
		| "decideLoginRequest"
		| "readToken"
		| "revokeToken"
		| "resolveToken"
	>;
	/** The console's origin, from the deployment's configuration (configuration.ts). */
	publicBaseUrl: string;
	github?: GitHubGateway | undefined;
	slack?: SlackGateway | undefined;
	auth?: HumanAuthGateway | undefined;
	artifacts?: ArtifactGateway | undefined;
	recordings?: BrowserRecordingGateway | undefined;
	/**
	 * The one request a Trusted Access verification makes, with the header the
	 * store opened (trusted-access-runtime.ts verifyTrustedProductionAccess).
	 */
	verifyTrustedAccess?: ((input: TrustedAccessVerificationInput) => Promise<{ verified: boolean }>) | undefined;
	signInTakeover?: SignInTakeoverGateway | undefined;
	signInVerification?: SignInVerificationGateway | undefined;
	/**
	 * The shared password the internal waiting list is authorized by, from
	 * WAITLIST_ADMIN_PASSWORD. Absent, that lane answers 503 rather than letting
	 * anybody through.
	 */
	waitlistAdminPassword?: string | undefined;
	waitlistMailer?: WaitlistMailer | undefined;
	onWorkAvailable?: (() => void | Promise<void>) | undefined;
	/**
	 * Shows the end of a run that ended with no worker to see it (a cancel of a
	 * run still queued): a conversation thread's to-do list. Never throws.
	 */
	workProgress?: Pick<WorkProgress, "settle"> | undefined;
}
