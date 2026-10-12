// The pi SDK as every pi lane opens it — the Activity session, the suite
// runner's agent turns and the one-shot, and a conversation's host turn: the
// module, the model as ShipBash's gateway serves it, the one posture every
// session opens in, the data sources it reads through pi's own MCP extension,
// and the `deliver` tool a structured answer arrives through.
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { AGENT_SERVICE_VARIABLES } from "@shipbash/contracts/runtime/agent-model.mjs";

import { retryDroppedStreams } from "./dropped-stream.mjs";
import { dataSourceExtensions, registerTokenProviders, unavailableSourcesUi } from "./pi-data-sources.mjs";
import { showNewestToolImages } from "./tool-images.mjs";

// The runner image's lanes load the SDK installed beside them. The specifier
// stays out of the import call as a literal so host-side bundlers (vitest
// transforming a runtime file into a test graph) never pull pi into a graph
// that does not use it. A conversation's host turn never comes here: its
// caller imports pi with a literal specifier, so the bundler traces it, and
// hands it to openAgentSession.
const PI_SDK_MODULE = "@earendil-works/pi-coding-agent";
// pi's built-in OpenAI provider: its catalog entry for the model and its
// Responses implementation, pointed at the gateway.
const PI_PROVIDER = "openai";

/**
 * pi's built-in tools (pi 1.0.1 docs/settings.md "Available built-in tools").
 * No session holds one: agents read the product's code on GitHub, and a
 * mounted checkout is the sandbox terminal's. openAgentSession excludes them
 * all.
 */
export const PI_BUILTINS = Object.freeze(["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"]);

/**
 * The resource tools pi's MCP extension registers for any server that
 * advertises MCP resources, as GitHub's does. No session holds them: no
 * capability row gives them, and get_file_contents at a ref reads whatever
 * they would.
 */
const MCP_RESOURCE_TOOLS = Object.freeze(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/** The SDK a caller handed in, else the one installed in the container. */
export async function loadPiSdk(injected) {
  return injected ?? await import(/* @vite-ignore */ PI_SDK_MODULE);
}

/**
 * pi's model runtime, and `modelId` as every lane reaches it: pi's catalog
 * entry, served by the deployment's model gateway at the tier it asks for. The
 * runtime's credential store is pinned to `directory`, which ShipBash never
 * writes: in pi a stored credential outranks a configured key
 * (composeApiKeyAuth), so pinning it keeps a login some `~/.pi` holds from
 * overriding the gateway key. The key is a reference pi resolves per request,
 * so a missing variable fails the call ("No API key found for openai."). The
 * prompts were tuned at low verbosity, which the provider the agents ran on
 * before sent with every request.
 * @param {typeof import("@earendil-works/pi-coding-agent")} pi
 * @param {string} directory
 * @param {string} modelId
 * @param {Omit<import("@shipbash/contracts/runtime/agent-model.mjs").AgentServices["model"], "apiKey">} gateway
 */
export async function openPiModel(pi, directory, modelId, gateway) {
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    // No user models file, by the same rule that keeps a repository's pi
    // settings out of a session: the harness alone decides how the agent runs.
    // Without one, pi keeps its model catalog in memory.
    modelsPath: null,
    refreshOnCreate: false,
  });
  const catalogModel = modelRuntime.getModel(PI_PROVIDER, modelId);
  if (!catalogModel) throw new Error(`The requested ${PI_PROVIDER} model is unavailable: ${modelId}`);
  // A model's own endpoint outranks its provider's, so the catalog's goes.
  const { baseUrl: _catalogEndpoint, ...metadata } = catalogModel;
  const tier = gateway.serviceTier ? { service_tier: gateway.serviceTier } : {};
  modelRuntime.registerProvider(PI_PROVIDER, {
    baseUrl: gateway.baseUrl,
    apiKey: `$${AGENT_SERVICE_VARIABLES.modelApiKey}`,
    models: [{ ...metadata, samplingParams: { ...tier, text: { verbosity: "low" } } }],
  });
  return { modelRuntime, model: modelRuntime.getModel(PI_PROVIDER, modelId) };
}

/**
 * A pi session in the posture every ShipBash agent runs in: the harness
 * alone decides how it runs, whatever the directories it works in hold.
 * - No resources from disk. All five loader switches are off, so no
 *   extension, skill, prompt template, theme, or context file (AGENTS.md,
 *   CLAUDE.md, in the cwd or any ancestor) is loaded; only the caller's
 *   inline extension factories run, which pi loads whatever the switches say.
 * - One settings manager for the loader and the session, in memory and with
 *   the cwd untrusted: no settings.json is read from the cwd or the agent
 *   directory, and pi's defaults stand. Settings the harness ever sets go in
 *   the values `inMemory` is created with: a loader reload re-reads those and
 *   drops `applyOverrides`.
 * - An agent directory of its own, made fresh for the session under the
 *   caller's scratch directory: never persisted, never the home, the checkout
 *   or a mount the agent's tools are pointed at. pi reads nothing there but
 *   the credential store openPiModel pins to it.
 * - None of pi's builtins, nor the MCP extension's resource tools; the
 *   caller's own tools come in as customTools.
 * - One cwd for the loader and the session, constant for the caller's site:
 *   pi states it in every system prompt.
 * - Of the images its tools return, such as screenshots, only the newest
 *   few reach the model (tool-images.mjs).
 * - A response cut off mid-stream is retried by pi from the transcript as it
 *   stands, the gateway's dropped streams among them (dropped-stream.mjs).
 * - Its data sources through pi's own MCP extension (pi-data-sources.mjs),
 *   connected in the background once the session starts: a server that cannot
 *   be reached leaves the session without its tools, and its source hears why.
 * The system prompt is the caller's, whole, with its appendix. A session that
 * did not keep the contract's model and effort is disposed and refused. The
 * gateway is the caller's: a host's configuration names it, a runner's
 * environment does.
 * @param {typeof import("@earendil-works/pi-coding-agent")} pi
 * @param {{
 *   gateway: Omit<import("@shipbash/contracts/runtime/agent-model.mjs").AgentServices["model"], "apiKey">,
 *   cwd: string,
 *   scratchDirectory: string,
 *   modelContract: { model: string, reasoningEffort: string },
 *   systemPrompt: string,
 *   appendSystemPrompt?: string[],
 *   extensionFactories?: import("@earendil-works/pi-coding-agent").InlineExtension[],
 *   dataSources?: import("./pi-data-sources.mjs").DataSource[],
 *   session: Record<string, unknown>,
 * }} options `session`: the site's tools and transcript (customTools,
 *   sessionManager), its sessionManager made with this cwd
 */
export async function openAgentSession(pi, options) {
  const { cwd, modelContract, systemPrompt, appendSystemPrompt = [], extensionFactories = [], dataSources = [] } = options;
  const agentDir = await mkdtemp(join(options.scratchDirectory, "pi-agent-"));
  const { modelRuntime, model } = await openPiModel(pi, agentDir, modelContract.model, options.gateway);
  const failures = new Map();
  registerTokenProviders(modelRuntime, dataSources, failures);
  const settingsManager = pi.SettingsManager.inMemory({}, { projectTrusted: false });
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => appendSystemPrompt,
    extensionFactories: [showNewestToolImages, retryDroppedStreams, ...extensionFactories, ...dataSourceExtensions(pi, agentDir, dataSources)],
  });
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({
    ...options.session,
    excludeTools: [...PI_BUILTINS, ...MCP_RESOURCE_TOOLS],
    cwd, agentDir, modelRuntime, model, thinkingLevel: modelContract.reasoningEffort, settingsManager, resourceLoader,
  });
  // pi clamps an effort the model lacks, and a resumed transcript can name
  // another model: the session runs on what the contract asked for, or not at all.
  if (session.model?.id !== modelContract.model || session.thinkingLevel !== modelContract.reasoningEffort) {
    session.dispose();
    throw new Error("The pi session did not retain the requested model and reasoning effort.");
  }
  // session_start: the MCP extension starts connecting the data sources.
  if (dataSources.length > 0) await session.bindExtensions({ uiContext: unavailableSourcesUi(session, dataSources, failures) });
  return session;
}

/**
 * Ends a session: pi's dispose emits no session_shutdown, which is what closes
 * the MCP extension's connections to the session's data sources.
 * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
 */
export async function closeAgentSession(session) {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
  session.dispose();
}

/**
 * Hears each model response's failure as the response ends: its error, or
 * null for one that did not fail. Whether a run failed is its last response's
 * to say: pi retries a dropped or refused model call (dropped-stream.mjs), and
 * the attempt it retried still ends a message, so the response after it
 * clears what the attempt named. A walk finished its work after a
 * retried "terminated" and was failed for it.
 * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
 * @param {(failure: string | null) => void} onFailure
 */
export function subscribeResponseFailure(session, onFailure) {
  session.subscribe((event) => {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const { stopReason, errorMessage } = event.message;
    onFailure(stopReason === "error" ? errorMessage?.trim() || "The model call failed." : null);
  });
}

/**
 * The `deliver` tool: the schema is the parameters, so pi enforces the shape.
 * @param {Record<string, unknown>} schema
 * @param {(params: Record<string, unknown>) => void} capture
 * @param {string} description
 */
export function deliverTool(schema, capture, description) {
  const { $schema: _meta, ...parameters } = schema;
  return {
    name: "deliver",
    label: "deliver",
    description,
    parameters,
    executionMode: "sequential",
    /** @param {string} _toolCallId @param {Record<string, unknown> | undefined} params */
    execute: async (_toolCallId, params) => {
      capture(params ?? {});
      return { content: [{ type: "text", text: "Delivered." }], details: undefined, terminate: true };
    },
  };
}
