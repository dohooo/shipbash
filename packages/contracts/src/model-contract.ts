import { AGENT_MODEL, type AGENT_REASONING_EFFORTS } from "./runtime/agent-model.mjs";
import { activityKnowledgeSurface } from "./runtime/discovery-surface.mjs";
import { PUBLIC_PROJECTS_AGENT_RUNTIME_VALUES } from "./runtime/generated/db-vocabularies.mjs";
import type { ActivityKind, ProjectAgentRuntime } from "./database-contract-types.ts";

// The Agent runtime a Project runs on, from the projects.agent_runtime vocabulary.
const AGENT_RUNTIMES: readonly string[] = PUBLIC_PROJECTS_AGENT_RUNTIME_VALUES;

export type AgentRuntime = ProjectAgentRuntime;

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === "string" && AGENT_RUNTIMES.includes(value);
}

type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export type AgentModelContract = {
  provider: "openai";
  model: string;
  reasoningEffort: AgentReasoningEffort;
};

/**
 * The role an agent plays, and the reasoning effort that role runs at. The
 * passes that plan — Discovery and the Suite maintainer — run at high: in a
 * paired comparison high judged as accurately as xhigh, ran
 * faster, and was the only effort whose evidence review fit its production
 * budget. A Suite case, which drives the browser wherever Jev hands off,
 * answers fast.
 */
export type AgentRole = "discovery" | "maintenance" | "verification" | "walk" | "sign_in";

const roleContract = (reasoningEffort: AgentReasoningEffort, model: string = AGENT_MODEL): Readonly<AgentModelContract> =>
  Object.freeze({ provider: "openai", model, reasoningEffort });

const ROLE_CONTRACTS: Readonly<Record<AgentRole, Readonly<AgentModelContract>>> = Object.freeze({
  discovery: roleContract("high"),
  maintenance: roleContract("high"),
  verification: roleContract("medium", "gpt-6-luna"),
  walk: roleContract("low"),
  // A password sign-in check stays on the larger model: on luna it false-failed a right password (measured).
  sign_in: roleContract("medium"),
});

export function modelContractFor(role: AgentRole): AgentModelContract {
  return { ...ROLE_CONTRACTS[role] };
}

/**
 * An Activity's role: a walk checks or does one thing the chat asked for, as
 * a Suite case walks one Journey, so it answers at the case's effort; a kind
 * that converses (Discovery, a conversation) is discovery, every other kind
 * the Suite maintainer.
 */
export function activityModelRole(kind: ActivityKind): AgentRole {
  if (kind === "walk") return "walk";
  return activityKnowledgeSurface(kind).interacts ? "discovery" : "maintenance";
}
