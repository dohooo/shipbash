/**
 * Bootstrap phase 6: route channel assembly.
 *
 * Wires every handler shard's channel from the pieces the earlier phases
 * built and wraps the resulting dispatcher in the HTTP server. This is pure
 * plumbing — the only logic is the error envelope around the dispatcher.
 */
import { createServer, type Server } from "node:http";

import { vercelDeploymentIdentity } from "../../job-api/identity.ts";
import { verifyTrustedProductionAccess } from "../../trusted-access-runtime.ts";
import { createRouteDispatcher, type RouteDispatcherContext } from "../route-dispatcher.ts";
import { createLoggingWaitlistMailer } from "../waitlist-mailer-log.ts";
import { sendLocalRouteError } from "../http-input.ts";
import type { ServiceGateways } from "./gateways.ts";
import type { ServiceLanes } from "./lanes.ts";
import type { ResolvedServiceConfig } from "./options.ts";
import type { ServiceStores } from "./stores.ts";
import type { DispatchWorkers } from "./dispatch-workers.ts";

/**
 * The authenticated API surface, or null when it is unconfigured so those
 * paths answer 503. Every optional gateway stays conditionally spread, so an
 * absent one leaves its key off the options object entirely.
 */
function buildApiOptions(input: {
  stores: ServiceStores;
  config: ResolvedServiceConfig;
  lanes: ServiceLanes;
  workers: DispatchWorkers;
  gateways: ServiceGateways;
}): RouteDispatcherContext["apiOptions"] {
  const { stores, config, lanes, workers, gateways } = input;
  const { tenantStore, actorSigningSecret, github, slack } = stores;
  const { artifactGateway, browserRecordingGateway } = stores.gateways;
  const { humanAuthGateway, signInTakeoverGateway, signInVerificationGateway, authenticatorGateway } = gateways;
  const { threadLists } = workers;

  if (!tenantStore) return null;
  return () => ({
    store: tenantStore.actor,
    internal: tenantStore.internal,
    cli: tenantStore.cli,
    actorSigningSecret,
    publicBaseUrl: config.publicBaseUrl,
    ...(github ? { github } : {}),
    ...(slack ? { slack } : {}),
    ...(humanAuthGateway ? { auth: humanAuthGateway } : {}),
    ...(artifactGateway ? { artifacts: artifactGateway } : {}),
    ...(browserRecordingGateway ? { recordings: browserRecordingGateway } : {}),
    verifyTrustedAccess: verifyTrustedProductionAccess,
    ...(signInTakeoverGateway ? { signInTakeover: signInTakeoverGateway } : {}),
    ...(signInVerificationGateway ? { signInVerification: signInVerificationGateway } : {}),
    ...(authenticatorGateway ? {authenticators:authenticatorGateway} : {}),
    // Local development never sends: the mailer writes the message to this
    // process's log, so letting someone in is testable without a key.
    waitlistMailer: createLoggingWaitlistMailer(config.publicBaseUrl),
    ...(config.integrations.waitlistAdminPassword
      ? { waitlistAdminPassword: config.integrations.waitlistAdminPassword }
      : {}),
    onWorkAvailable: lanes.reconcileDispatchQueue,
    ...(threadLists ? { workProgress: threadLists } : {}),
  });
}

export function createServiceServer(input: {
  config: ResolvedServiceConfig;
  stores: ServiceStores;
  lanes: ServiceLanes;
  workers: DispatchWorkers;
  gateways: ServiceGateways;
}): Server {
  const { config, stores } = input;

  const route = createRouteDispatcher({
    baseUrl: config.baseUrl,
    slackWebhook: input.gateways.slackWebhook,
    apiOptions: buildApiOptions(input),
    publicMedia: stores.artifactStorage && stores.browserRecordingStorage
      ? { artifact: stores.artifactStorage, recording: stores.browserRecordingStorage }
      : null,
    tenantStore: stores.tenantStore,
    jobApi: stores.jobApi && { ...stores.jobApi, deploymentIdentity: vercelDeploymentIdentity },
  });

  return createServer((request, response) => {
    void route(request, response).catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendLocalRouteError(response, error);
    });
  });
}
