/**
 * The only place a secret becomes Sandbox configuration. Every Sandbox we
 * create (a task, a sign-in viewer or takeover, a password check) is created
 * with this firewall policy, and its environment holds placeholders instead
 * of keys:
 *
 * - the model gateway and Jev get their key injected by a `transform` rule
 *   on the one method and path the agents call, with `Host` pinned; every
 *   other request to those hosts is answered 403 by the firewall itself;
 * - the runtime bundle's private Blob URL gets its read token the same way;
 * - a task Sandbox's job API name is forwarded to the console, which the
 *   firewall signs with the Sandbox's Vercel identity (job-api/identity.ts);
 * - everything else stays reachable, for the product under test.
 *
 * Chromium does not trust the firewall's CA, so a page in the browser under
 * test can neither ride these keys nor the forward rule.
 */
import type { NetworkPolicy, NetworkPolicyRule } from "@vercel/sandbox";

import { AGENT_SERVICE_VARIABLES, type AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";
import { JOB_API_HOST_VARIABLE } from "@shipbash/contracts/runtime/job-api-contract.mjs";

import type { RuntimeBundle } from "./vercel-sandbox-dispatch/runtime-bundle.ts";

/** What a Sandbox's environment holds where a key would be: the clients only need a value to send. */
export const SANDBOX_KEY_PLACEHOLDER = "injected-by-sandbox-firewall";

const REFUSED: NetworkPolicyRule = {
  response: { statusCode: 403, contentType: "text/plain", body: "blocked by sandbox policy\n" },
};

/** One brokered endpoint: its key injected on exactly this method and path, the rest of its host refused. */
function brokered(endpoint: string, method: "GET" | "POST", key: string): [string, NetworkPolicyRule[]] {
  const url = new URL(endpoint);
  return [url.hostname, [
    {
      match: { method: [method], path: { exact: url.pathname } },
      transform: [{ headers: { authorization: `Bearer ${key}`, host: url.host } }],
    },
    REFUSED,
  ]];
}

/**
 * The firewall policy of a Sandbox we create, from the deployment's agent
 * services (configuration.ts): every Sandbox runs an agent or Jev, so both
 * are always brokered; the bundle's rule is there only when its token is.
 * `jobApi` is a task Sandbox's job API name and its own job route on the
 * console.
 */
export function sandboxNetworkPolicy(
  agents: AgentServices,
  options: { runtimeBundle: RuntimeBundle | null; jobApi?: { host: string; forwardUrl: string } },
): NetworkPolicy {
  const { runtimeBundle, jobApi } = options;
  const rules: Array<[string, NetworkPolicyRule[]]> = [
    brokered(`${agents.model.baseUrl}/responses`, "POST", agents.model.apiKey),
    brokered(agents.jev.url, "POST", agents.jev.apiKey),
  ];
  if (runtimeBundle?.token) rules.push(brokered(runtimeBundle.url, "GET", runtimeBundle.token));
  if (jobApi) rules.push([jobApi.host, [{ forwardURL: jobApi.forwardUrl }]]);
  rules.push(["*", []]);
  return { allow: Object.fromEntries(rules) };
}

/**
 * The agent services as a Sandbox's environment names them: where each one
 * answers, a placeholder exactly where the policy injects a key, and the job
 * API name a task asks at.
 */
export function sandboxAgentEnvironment(configuration: {
  agents: AgentServices;
  hosted: { jobApiHost: string };
}): Record<string, string> {
  const { agents, hosted } = configuration;
  return {
    [AGENT_SERVICE_VARIABLES.modelBaseUrl]: agents.model.baseUrl,
    [AGENT_SERVICE_VARIABLES.modelApiKey]: SANDBOX_KEY_PLACEHOLDER,
    ...(agents.model.serviceTier ? { [AGENT_SERVICE_VARIABLES.modelServiceTier]: agents.model.serviceTier } : {}),
    [AGENT_SERVICE_VARIABLES.jevUrl]: agents.jev.url,
    [AGENT_SERVICE_VARIABLES.jevApiKey]: SANDBOX_KEY_PLACEHOLDER,
    [JOB_API_HOST_VARIABLE]: hosted.jobApiHost,
  };
}
