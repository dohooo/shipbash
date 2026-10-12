import "server-only";

import { SupabaseArtifactStorage } from "@shipbash/control-plane/artifact-storage";
import { SupabaseBrowserRecordingStorage } from "@shipbash/control-plane/browser-recording-storage";
import {
	configurationRuntime,
	type HostedRuntimeConfiguration,
	hostedConfiguration,
} from "@shipbash/control-plane/configuration";
import { type GitHubAppProvider, hostedGitHubAppProvider } from "@shipbash/control-plane/github-app-provider";
import { GitHubTenantService } from "@shipbash/control-plane/github-tenant-service";
import { vercelDeploymentIdentity } from "@shipbash/control-plane/job-api/identity";
import type { JobApiDeps } from "@shipbash/control-plane/job-api/server";
import {
	createSlackDelivery,
	type SlackDelivery,
} from "@shipbash/control-plane/slack-chat/delivery";
import { SlackTenantService } from "@shipbash/control-plane/slack-tenant-service";
import {
	createTenantStore,
	type TenantStore,
} from "@shipbash/control-plane/store/tenant-store";
import {
	type DispatchWorkflowStarters,
	dispatchVercelSandboxWork,
} from "@shipbash/control-plane/vercel-sandbox-work";
import { start } from "workflow/api";
import { conversationTurnWorkflow } from "../workflows/conversation-turn";
import { vercelSandboxDispatchWorkflow } from "../workflows/vercel-sandbox-dispatch";
import { createProductionHumanAuthGateway } from "./production-human-auth";

/**
 * What a lambda builds from the deployment's configuration (configuration.ts,
 * read once from the environment Vercel hands it), and builds once: the
 * store, the two storages, the Workflow starter, and the integrations the
 * deployment configures. Everything that serves a request reads the
 * resources from here rather than building its own.
 */
export interface ProductionRuntimeResources {
	store: TenantStore;
	/** Repository access; absent when the deployment has no GitHub App. */
	github: GitHubTenantService | undefined;
	artifactStorage: SupabaseArtifactStorage;
	browserRecordingStorage: SupabaseBrowserRecordingStorage;
	/** Starts a reserved Job's Workflow: a Sandbox's, or a conversation turn's (dispatchVercelSandboxWork). */
	workflows: DispatchWorkflowStarters;
	/** The Slack app the deployment installs and posts as; absent when it has none. */
	slack: SlackTenantService | undefined;
	/** What answers Slack's deliveries; absent exactly when `slack` is. */
	slackWebhook: SlackDelivery | undefined;
	actorSigningSecret: string;
	publicBaseUrl: string;
	/** What the job API serves a task Sandbox's calls from (/api/jobs). */
	jobApi: JobApiDeps;
	/** The configuration the resources were built from. */
	configuration: HostedRuntimeConfiguration;
}

let runtimeResources: ProductionRuntimeResources | null = null;

/** Whether this process is the hosted runtime, by the configuration's own rule. */
export function isVercelRuntime(
	environment: NodeJS.ProcessEnv = process.env,
): boolean {
	return configurationRuntime(environment) === "hosted";
}

function githubResources(
	configuration: HostedRuntimeConfiguration,
	store: TenantStore,
): Pick<ProductionRuntimeResources, "github"> & { provider: GitHubAppProvider | null } {
	const { github } = configuration.integrations;
	if (!github) return { provider: null, github: undefined };
	const provider = hostedGitHubAppProvider(github);
	return {
		provider,
		github: new GitHubTenantService(provider, store.actor, store.internal, configuration.publicUrl),
	};
}

function slackResources(
	configuration: HostedRuntimeConfiguration,
	store: TenantStore,
	onWorkAvailable: () => Promise<void>,
): Pick<ProductionRuntimeResources, "slack" | "slackWebhook"> {
	const slackApp = configuration.integrations.slack;
	if (!slackApp) return { slack: undefined, slackWebhook: undefined };
	const { publicUrl: origin, actorSigningSecret } = configuration;
	return {
		slack: new SlackTenantService(slackApp, store.actor, origin),
		slackWebhook: createSlackDelivery({
			configuration: slackApp,
			databaseUrl: configuration.hosted.databaseUrl,
			store: store.internal,
			publicOrigin: origin,
			jev: configuration.agents.jev,
			// A conversation's legs are queued work, dispatched as the API
			// dispatches it, and its Stop ends a sign-in the way the API's does.
			conversations: {
				store: store.actor,
				onWorkAvailable,
				auth: createProductionHumanAuthGateway({
					store: store.actor,
					authState: store.targetAuthState,
					handoffs: store.targetAuthHandoffs,
					actorSigningSecret,
					onWorkAvailable,
				}),
			},
		}),
	};
}

function createProductionRuntimeResources(): ProductionRuntimeResources {
	if (!isVercelRuntime()) {
		throw new Error("The production runtime is only available on Vercel.");
	}
	const configuration = hostedConfiguration();
	const { hosted, publicUrl: origin, actorSigningSecret, signInKeyring, runQuota } = configuration;
	// The keyring seals what lives in Postgres: Team sign-ins.
	const store = createTenantStore(hosted.databaseUrl, { maxConnections: 1, signInKeyring, runQuota });
	const workflows: DispatchWorkflowStarters = {
		sandbox: (input) => start(vercelSandboxDispatchWorkflow, [input]),
		conversationTurn: (input) => start(conversationTurnWorkflow, [input]),
	};
	const onWorkAvailable = () => dispatchVercelSandboxWork(store.internal, workflows);
	const artifactStorage = new SupabaseArtifactStorage(hosted.supabase);
	const browserRecordingStorage = new SupabaseBrowserRecordingStorage(hosted.supabase);
	const { provider, github } = githubResources(configuration, store);
	return {
		store,
		github,
		artifactStorage,
		browserRecordingStorage,
		workflows,
		...slackResources(configuration, store, onWorkAvailable),
		actorSigningSecret,
		publicBaseUrl: origin,
		jobApi: {
			publicOrigin: origin,
			store,
			artifactStorage,
			browserRecordingStorage,
			githubApp: provider,
			deploymentIdentity: vercelDeploymentIdentity,
		},
		configuration,
	};
}

export function getProductionRuntimeResources(): ProductionRuntimeResources {
	runtimeResources ??= createProductionRuntimeResources();
	return runtimeResources;
}
