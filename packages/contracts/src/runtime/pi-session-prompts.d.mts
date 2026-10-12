import type { CAPABILITIES, SCENARIOS } from "./capabilities.mjs";

export declare const PI_SESSION_ADDENDUM: string;
export declare const PI_SESSION_ENDING_INTERACTIVE: string;
export declare const PI_SESSION_ENDING_UNATTENDED: string;
export declare const CHAT_SESSION_ADDENDUM: string;

export declare function buildChatSessionSystemPrompt(instructions: string): string;

export declare function buildPiSessionSystemPrompt(surface: { interacts?: boolean }): string;

export interface ScenarioPrompt {
  systemPrompt: string;
  appendSystemPrompt: string[];
}

export declare function scenarioPrompt(kind: string, rows: readonly string[], options?: { instructions?: string }): ScenarioPrompt;

export declare function agentPromptIdentity(chatInstructions: string): {
  capabilities: typeof CAPABILITIES;
  scenarios: typeof SCENARIOS;
  prompts: Record<string, ScenarioPrompt>;
};
