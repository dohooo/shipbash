/**
 * The gateway contracts the API is wired with: every side-effectful
 * capability the routes touch (browser recordings, artifacts, human auth,
 * GitHub) enters through one of these interfaces, so the API surface
 * stays testable without the machinery behind it.
 */

import type { GitHubAuthorizationOutcome, GitHubSetupRedirect } from "../github-tenant-service-connect.ts";
import type { ActorStore } from "../store/actor-store.ts";
import type { TeamSignIn } from "../store/team-sign-ins.ts";
import type {
  SlackDeliveryError,
  TeamSignInMethod,
} from "@shipbash/contracts/database-contract-types";
import type { SlackChannelList } from "../slack-channels.ts";
import type { GitHubRepositoryCoordinates } from "../github-app/reads.ts";
import type { GitHubBindingView, GitHubConnectionView } from "../github-connections.ts";
import type { TenantActor } from "../types.ts";
import type { ZipEntry } from "./zip-stream.ts";


/**
 * The Project's human-takeover sign-in browser, which belongs to no Activity.
 * A grant names the stream the canvas paints and the lease it claims input
 * with; releasing ends the session and the browser behind it.
 */
export interface SignInTakeoverGateway {
  takeover(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    /** The way in being added; a third-party one opens on the provider's own sign-in page. */
    method: TeamSignInMethod | null;
  }): Promise<{ streamUrl: string; controlToken: string }>;
  release(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
  }): Promise<void>;
}

/**
 * Finishing a sign-in and the check that decides it. `complete` captures what
 * the takeover browser holds, saves it for the Team as `verifying`, and puts
 * a verification leg behind it; the sign-in it answers with is never ready
 * yet, because nothing has been proven at the moment the person let go.
 */
export interface SignInVerificationGateway {
  complete(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    method: TeamSignInMethod;
  }): Promise<TeamSignIn>;
  /**
   * Checks a sign-in this Project has bound, again: the auto-login leg for a
   * saved email and password, the verification leg for a session already kept.
   * Answers the sign-in as `verifying`; the tick arrives from the leg.
   */
  verify(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    signInId: string;
  }): Promise<TeamSignIn>;
  /** The running leg's screencast, so the page can show the check. */
  streamUrl(signInId: string): string | null;
  /**
   * Moves the Project's verification runs onto a ready way in it has bound,
   * and starts them from the session that way in keeps.
   */
  chooseForRuns(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    signInId: string;
  }): Promise<void>;
}

export interface BrowserRecordingGateway {
  signedUrl(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    recordingId: string;
    kind: "content" | "poster";
  }): Promise<string | null>;
}

/** A stored file of an evidence bundle: where it is stored, and where it lies in the bundle. */
export interface BundleFile {
  objectPath: string;
  path: string;
}

export interface ArtifactGateway {
  /** `download`: signed to be saved as a file named for its label, not shown. */
  signedUrl?(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    runId: string;
    artifactId: string;
    download: boolean;
  }): Promise<string | null>;
  signedActivityFinalUrl?(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    activityId: string;
  }): Promise<string | null>;
  download(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    runId: string;
    artifactId: string;
  }): Promise<{ body: Buffer; contentType: string; label: string } | null>;
  /**
   * The bytes of these files, read ahead and yielded in the order asked, each
   * as the entry its file is in the bundle. A read that fails ends the iteration.
   */
  readBundleFiles(input: { files: readonly BundleFile[] }): AsyncIterable<ZipEntry>;
  downloadActivityFinal(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    activityId: string;
  }): Promise<{ body: Buffer; contentType: string; label: string } | null>;
  /** A retained terminal session log; small NDJSON text, served by download. */
  downloadActivityTerminalLog(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    activityId: string;
    sessionId: string;
  }): Promise<{ body: Buffer; contentType: string; label: string } | null>;
}

export interface HumanAuthGateway {
  status(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    targetKind: "run" | "activity";
    targetId: string;
    productionUrl: string;
    /** True when the Activity stands still on an open question — its live browser takes the control lease. */
    activityLiveTakeover?: boolean;
  }): Promise<{ waiting: boolean; authViewerUrl: string | null; controlToken?: string | null }>;
  /**
   * Stores a takeover upload inside the target's control channel so the
   * in-container file chooser can select it. Activity takeovers only.
   */
  upload?(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    targetKind: "run" | "activity";
    targetId: string;
    productionUrl: string;
    fileName: string;
    bytes: Buffer;
  }): Promise<{ name: string }>;
  /** Read-only lookup of an existing session's viewer URL. Never starts a session. */
  peek(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    targetKind: "run" | "activity";
    targetId: string;
    productionUrl: string;
  }): string | null | Promise<string | null>;
  complete(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    targetKind: "run" | "activity";
    targetId: string;
    productionUrl: string;
    /** True when the Activity stands still on an open question — its live browser takes the control lease. */
    activityLiveTakeover?: boolean;
  }): Promise<{ resumed: boolean }>;
  cancel(input: {
    actor: TenantActor;
    teamId: string;
    projectId: string;
    targetKind: "run" | "activity";
    targetId: string;
    /** True when the Activity stands still on an open question — its live browser takes the control lease. */
    activityLiveTakeover?: boolean;
  }): Promise<void>;
}

/** Where an admin's Connect goes: GitHub's install page, or a local App's registration form. */
export type GitHubInstallRedirect =
  | { kind: "install_app"; url: string }
  | { kind: "register_app"; formAction: string; manifest: string };

export interface GitHubGateway {
  installRedirect(actor: TenantActor, teamId: string, returnPath: string): Promise<GitHubInstallRedirect>;
  completeManifest(actor: TenantActor, input: { state: string; code: string }): Promise<{ teamId: string }>;
  /** GitHub's setup redirect: where to authorize the App, or null when no state of the actor's names it. */
  beginAuthorization(actor: TenantActor, setup: GitHubSetupRedirect): Promise<string | null>;
  completeAuthorization(actor: TenantActor, input: {
    state: string;
    code: string;
  }): Promise<{ returnPath: string; outcome: GitHubAuthorizationOutcome }>;
  declineAuthorization(actor: TenantActor, state: string): Promise<string | null>;
  installationHome(actor: TenantActor, installationId: number): Promise<string | null>;
  installationReturnOrigin(actor: TenantActor, state: string): Promise<string | null>;
  connections(actor: TenantActor, teamId: string): Promise<GitHubConnectionView[]>;
  repositories(actor: TenantActor, teamId: string, connectionId: string): Promise<{
    repositories: GitHubRepositoryCoordinates[];
    truncated: boolean;
  }>;
  bind(actor: TenantActor, teamId: string, projectId: string, input: {
    connectionId: string;
    repositoryId: number;
  }): Promise<GitHubBindingView>;
  read(actor: TenantActor, teamId: string, projectId: string): Promise<GitHubBindingView>;
  unbind(actor: TenantActor, teamId: string, projectId: string): Promise<void>;
  disconnect(actor: TenantActor, teamId: string, connectionId: string): Promise<void>;
  resolveUser(login: string): Promise<{ id: number; login: string }>;
}

/**
 * Only the operations that need Slack itself. Listing a team's
 * workspaces and abandoning a pending install are store reads and writes, so
 * they run through the store like every other route and not through a gateway
 * that would only pass them on.
 */
export interface SlackGateway {
  authorizeUrl(actor: TenantActor, teamId: string, returnPath: string): Promise<string>;
  /** Read on demand, because it costs a call to Slack. */
  channels(actor: TenantActor, teamId: string, workspaceId: string): Promise<SlackChannelList>;
  /** Adds a channel to the project's once Slack confirms it can be posted in, and announces a new route there; null means saved. */
  bindChannel(
    actor: TenantActor,
    teamId: string,
    projectId: string,
    input: { workspaceId: string; channelId: string },
  ): Promise<SlackDeliveryError | null>;
  /** Sends a test message to one of the project's channels; null means Slack accepted it. */
  testBinding(
    actor: TenantActor,
    teamId: string,
    route: { projectId: string; channelId: string },
  ): Promise<SlackDeliveryError | null>;
  installReturn(actor: TenantActor, state: string): Promise<string | null>;
  /** The user refused on Slack's consent screen; that redirect is answered. */
  deny(actor: TenantActor, state: string): Promise<void>;
  complete(
    actor: TenantActor,
    input: { state: string; code: string; returnPath: string },
  ): Promise<void>;
  disconnect(actor: TenantActor, teamId: string, workspaceId: string): Promise<void>;
  /** Where a Slack user signs in with Slack, for the account they are signed in to ShipBash as. */
  signInUrl(actor: TenantActor, hint: { slackTeamId: string; channelId: string }): Promise<string>;
  /** Slack's redirect back: the sign-in to confirm, or a SlackSignInError saying why there is none. */
  completeSignIn(actor: TenantActor, input: { state: string; code: string }): Promise<string>;
}

/**
 * A send the mail provider refused. Named so the route can answer with what
 * went wrong instead of a bare 500, which would leave the only account of it
 * in the server log.
 */
export class WaitlistMailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaitlistMailError";
  }
}

/**
 * The waiting list's one message. Awaited inside the admitting transaction, so
 * a rejection here rolls the admission back rather than leaving somebody let
 * in who was never told.
 */
export interface WaitlistMailer {
  sendAdmission(input: {
    /** The address they joined on, which is also where the mail goes. */
    email: string;
    /** The normalized absolute URL they asked us to bash. */
    site: string;
  }): Promise<void>;
}

export type StoreSuiteDetail = NonNullable<Awaited<ReturnType<ActorStore["getSuiteDetail"]>>>;
export type StoreProposal = NonNullable<Awaited<ReturnType<ActorStore["getProposal"]>>>;
export type StoreRun = Awaited<ReturnType<ActorStore["listSuiteRuns"]>>[number];
export type StoreActivity = Awaited<ReturnType<ActorStore["listActivities"]>>[number];
export type StoreActivityDetail = NonNullable<Awaited<ReturnType<ActorStore["getActivityDetail"]>>>;
export type StoreRunDetail = NonNullable<Awaited<ReturnType<ActorStore["getSuiteRunDetail"]>>>;
export type StoreRunLog = NonNullable<Awaited<ReturnType<ActorStore["getSuiteRunLog"]>>>;
export type StoreRunStreamState = NonNullable<Awaited<ReturnType<ActorStore["getSuiteRunStreamState"]>>>;
export type StoreActivityStreamTick = NonNullable<Awaited<ReturnType<ActorStore["getActivityStreamTick"]>>>;

