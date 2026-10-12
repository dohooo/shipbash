// The types for pi-sdk.mjs: a conversation's host turn opens its session
// through it (control-plane conversation-turn/runtime.ts), and the pi type
// gate (tsconfig.pi.json) checks the runner's own lanes against them.
import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiModelRuntime = Awaited<ReturnType<PiSdk["ModelRuntime"]["create"]>>;

/** pi's built-in tools; a session holds only those its caller names. */
export const PI_BUILTINS: readonly string[];
/** The SDK a caller handed in, else the one installed in the runner image. */
export function loadPiSdk(injected?: unknown): Promise<PiSdk>;
/** The gateway a session's requests go to; its key is the variable pi resolves per request, never a value handed in. */
type Gateway = Omit<AgentServices["model"], "apiKey">;
export function openPiModel(pi: PiSdk, directory: string, modelId: string, gateway: Gateway): Promise<{
  modelRuntime: PiModelRuntime;
  model: ReturnType<PiModelRuntime["getModel"]>;
}>;
type SessionOptions = NonNullable<Parameters<PiSdk["createAgentSession"]>[0]>;
/**
 * A remote MCP server the agent reads through pi's MCP extension, its tools `mcp__<name>__*`, its token read per
 * request: `direct` for a session that resumes a transcript, `deferred` behind tool_search for one that never does.
 */
export interface DataSource {
  name: string;
  description: string;
  url: string;
  headers: Record<string, string>;
  exposure: "direct" | "deferred";
  token: () => Promise<string>;
  /** Why the server could not be connected; the session runs on without its tools. */
  onUnavailable: (reason: string) => void;
}
/** A pi session in ShipBash's one posture: no resources from disk, in-memory untrusted settings, a fresh agent directory, the caller's cwd, its data sources through pi's MCP extension. */
export function openAgentSession(pi: PiSdk, options: {
  gateway: Gateway;
  cwd: string;
  scratchDirectory: string;
  modelContract: { model: string; reasoningEffort: SessionOptions["thinkingLevel"] };
  systemPrompt: string;
  appendSystemPrompt?: string[];
  extensionFactories?: import("@earendil-works/pi-coding-agent").InlineExtension[];
  dataSources?: DataSource[];
  session: Pick<SessionOptions, "customTools" | "sessionManager">;
}): Promise<import("@earendil-works/pi-coding-agent").AgentSession>;
/** Ends a session, closing its data sources' connections, which pi's dispose leaves open. */
export function closeAgentSession(session: import("@earendil-works/pi-coding-agent").AgentSession): Promise<void>;
/** Hears each model response's failure as it ends, null for one that did not fail: a run's failure is its last response's. */
export function subscribeResponseFailure(
  session: import("@earendil-works/pi-coding-agent").AgentSession,
  onFailure: (failure: string | null) => void,
): void;
export function deliverTool(
  schema: Record<string, unknown>,
  capture: (params: Record<string, unknown>) => void,
  description: string,
): {
  name: "deliver";
  label: "deliver";
  description: string;
  parameters: Record<string, unknown>;
  executionMode: "sequential";
  execute(toolCallId: string, params: Record<string, unknown> | undefined): Promise<{ content: Array<{ type: "text"; text: string }>; details: undefined; terminate: true }>;
};
