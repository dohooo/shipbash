/**
 * Bootstrap phase 5: gateway assembly.
 *
 * The request-facing capabilities the route channels hand out: the human-auth
 * session surface with its gateway, the sign-in takeover, verification and
 * authenticator gateways, and the @ShipBash bot — whose
 * conversations ring the dispatch wake handle and whose Stop ends a sign-in
 * through the human-auth gateway. Built after the worker pool.
 */
import type { ApiOptions } from "../../api.ts";
import { createAuthSessions, type AuthSessions } from "../auth-sessions.ts";
import { createHumanAuthGateway } from "../human-auth-gateway.ts";
import { ensureFreshRunnerImage } from "../runtime-glue.ts";
import { providerSignInUrl } from "../provider-sign-in.ts";
import { createSignInTakeoverLane } from "../sign-in-takeover-lane.ts";
import { createSignInVerifyLane } from "../sign-in-verify-lane.ts";
import { createGithubAuthenticatorGateway } from "../github-authenticator.ts";
import { createSignInVerificationGateway } from "../sign-in-verification.ts";
import { RUNNER_IMAGE } from "../../runner-image.ts";
import { type SlackDelivery, createSlackDelivery } from "../../slack-chat/delivery.ts";
import type { ServiceLanes } from "./lanes.ts";
import type { ServiceRuntimeState } from "./lifecycle.ts";
import type { ResolvedServiceConfig } from "./options.ts";
import type { ServiceStores } from "./stores.ts";

export interface ServiceGateways {
  authSessions: AuthSessions;
  humanAuthGateway: ApiOptions["auth"];
  signInTakeoverGateway: ApiOptions["signInTakeover"];
  signInVerificationGateway: ApiOptions["signInVerification"];
  authenticatorGateway: ApiOptions["authenticators"];
  /** What answers Slack's deliveries; null where the deployment has no Slack app. */
  slackWebhook: SlackDelivery | null;
}

/**
 * Signing in by hand needs no Activity and no dispatch row: the lane opens a
 * browser-idle container for the Project and mints the control lease into its
 * mount. The gateway resolves the page it should open on with the caller's
 * own actor, so the lane itself never reads the store.
 */
function buildSignInGateways(input: {
  config: ResolvedServiceConfig;
  stores: ServiceStores;
  state: ServiceRuntimeState;
  lanes: ServiceLanes;
}): {
  takeover: ApiOptions["signInTakeover"];
  verification: ApiOptions["signInVerification"];
  authenticator: ApiOptions["authenticators"];
} {
  const { config, stores, state, lanes } = input;
  const { tenantStore, dockerBinaryOption } = stores;
  if (!tenantStore) return { takeover: undefined, verification: undefined, authenticator: undefined };
  const dockerBinary = () => dockerBinaryOption().dockerBinary ?? "docker";
  const takeoverLane = createSignInTakeoverLane({
    shipbashDirectory: config.shipbashDirectory,
    dockerBinary,
    runnerImage: RUNNER_IMAGE,
    projectHash: config.trackProjectHash,
    isShuttingDown: () => state.shuttingDown,
    ensureImage: ensureFreshRunnerImage,
  });
  const verifyLane = createSignInVerifyLane({
    shipbashDirectory: config.shipbashDirectory,
    dockerBinary,
    runnerImage: RUNNER_IMAGE,
    borrowBrowser: (projectId, startUrl) => takeoverLane.borrow(projectId, startUrl),
    projectHash: config.trackProjectHash,
    ensureImage: ensureFreshRunnerImage,
  });
  return {
    takeover: {
      // A third-party way in is signed in to at the provider itself; the
      // product's own doors open on the product.
      takeover: async ({ actor, teamId, projectId, method }) => takeoverLane.takeover(
        projectId,
        providerSignInUrl(method)
          ?? (await tenantStore.actor.getProject(actor, teamId, projectId))?.productionUrl
          ?? null,
      ),
      release: ({ projectId }) => takeoverLane.release(projectId),
    },
    authenticator: createGithubAuthenticatorGateway({store:tenantStore.authenticators,attention:tenantStore.authAttention}),
    verification: createSignInVerificationGateway({
      store: tenantStore.actor,
      takeover: takeoverLane,
      verify: verifyLane,
      promote: lanes.taskAuthPlumbing.promoteSignInAuthState,
      // The service process outlives the request that starts a leg.
      background: () => undefined,
      onWorkAvailable: lanes.reconcileDispatchQueue,
    }),
  };
}

export function createServiceGateways(input: {
  config: ResolvedServiceConfig;
  stores: ServiceStores;
  state: ServiceRuntimeState;
  lanes: ServiceLanes;
}): ServiceGateways {
  const { config, stores, state, lanes } = input;
  const { shipbashDirectory } = config;
  const { tenantStore, deps, dockerBinaryOption } = stores;
  const { inlineActivityAuthSessions, reconcileDispatchQueue } = lanes;

  const authSessions = createAuthSessions({
    deps,
    tenantStore,
    inlineActivityAuthSessions,
    ownership: lanes.taskAuthOwners,
    shipbashDirectory,
    trackProjectHash: config.trackProjectHash,
    dockerBinaryOption,
    isShuttingDown: () => state.shuttingDown,
  });

  const humanAuthGateway: ApiOptions["auth"] = tenantStore
    ? createHumanAuthGateway({
        tenantStore,
        authSessions,
        inlineActivityAuthSessions,
        deps,
        shipbashDirectory,
        dockerBinaryOption,
        reconcileDispatchQueue,
      })
    : undefined;

  const signInGateways = buildSignInGateways({ config, stores, state, lanes });

  const slackWebhook = tenantStore && stores.slackBot
    ? createSlackDelivery({
        ...stores.slackBot,
        store: tenantStore.internal,
        publicOrigin: config.publicBaseUrl,
        conversations: { store: tenantStore.actor, onWorkAvailable: reconcileDispatchQueue, auth: humanAuthGateway },
      })
    : null;

  return {
    authSessions,
    humanAuthGateway,
    signInTakeoverGateway: signInGateways.takeover,
    signInVerificationGateway: signInGateways.verification,
    authenticatorGateway: signInGateways.authenticator,
    slackWebhook,
  };
}
