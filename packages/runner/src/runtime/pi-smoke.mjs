// Build-time smoke for the pi SDK inside the runner image: asserts the API
// surface the activity lane depends on actually exists in the pinned version,
// that a session store can be created and disposed, and that the gateway
// registration every agent rides (pi-sdk.mjs openPiModel) still behaves: the
// catalog model served at the gateway it is handed, at that gateway's tier,
// keyed by the gateway key alone. The build has no deployment, so the smoke
// names a gateway of its own. A pi upgrade that breaks any of these fails the image
// build instead of the first live run; a dropped tier or endpoint would
// otherwise fail silently, the requests still answering.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_MODEL, AGENT_SERVICE_VARIABLES } from "@shipbash/contracts/runtime/agent-model.mjs";

import { openPiModel } from "./pi-sdk.mjs";

const pi = await import("@earendil-works/pi-coding-agent");

const required = ["createAgentSession", "DefaultResourceLoader", "ModelRuntime", "SessionManager", "SettingsManager"];
for (const name of required) {
  if (typeof pi[name] !== "function" && typeof pi[name] !== "object") {
    throw new Error(`pi SDK is missing ${name} — the activity lane cannot run on this version.`);
  }
}
for (const method of ["open", "create"]) {
  if (typeof pi.SessionManager[method] !== "function") {
    throw new Error(`pi SessionManager.${method} is missing.`);
  }
}
if (typeof pi.ModelRuntime.create !== "function") throw new Error("pi ModelRuntime.create is missing.");
if (typeof pi.SettingsManager.create !== "function") throw new Error("pi SettingsManager.create is missing.");

const directory = mkdtempSync(join(tmpdir(), "pi-smoke-"));
try {
  const manager = pi.SessionManager.create(directory, directory);
  if (!manager) throw new Error("pi SessionManager.create returned nothing.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

/**
 * The key pi resolves for `model`, or null when it resolves none.
 * @param {Awaited<ReturnType<typeof openPiModel>>["modelRuntime"]} modelRuntime
 * @param {Awaited<ReturnType<typeof openPiModel>>["model"]} model
 */
async function resolvedKey(modelRuntime, model) {
  try {
    return (await modelRuntime.getAuth(model))?.auth?.apiKey ?? null;
  } catch {
    return null;
  }
}

const SMOKE_GATEWAY = "https://gateway.smoke.example/v1";
const gatewayDirectory = mkdtempSync(join(tmpdir(), "pi-smoke-gateway-"));
const { modelApiKey } = AGENT_SERVICE_VARIABLES;
try {
  delete process.env[modelApiKey];
  const { modelRuntime, model } = await openPiModel(pi, gatewayDirectory, AGENT_MODEL, { baseUrl: SMOKE_GATEWAY, serviceTier: "priority" });
  if (model.baseUrl !== SMOKE_GATEWAY) {
    throw new Error(`pi serves ${AGENT_MODEL} at ${String(model.baseUrl)}, not the gateway.`);
  }
  if (model.samplingParams?.service_tier !== "priority") {
    throw new Error(`pi dropped the priority tier from ${AGENT_MODEL}'s requests.`);
  }
  if (await resolvedKey(modelRuntime, model) !== null) {
    throw new Error(`pi resolved a key without ${modelApiKey}: it fell back to another credential.`);
  }
  process.env[modelApiKey] = "sk-smoke-gateway";
  if (await resolvedKey(modelRuntime, model) !== "sk-smoke-gateway") {
    throw new Error(`pi does not authenticate ${AGENT_MODEL} with ${modelApiKey}.`);
  }
} finally {
  delete process.env[modelApiKey];
  rmSync(gatewayDirectory, { recursive: true, force: true });
}
process.stdout.write("pi smoke ok\n");
