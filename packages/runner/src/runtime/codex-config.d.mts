// The types for codex-config.mjs: the hosts that place Codex's system layer
// for a runner (control-plane docker-runtime and vercel-sandbox-runtime).
import type { AgentServices } from "@shipbash/contracts/runtime/agent-model.mjs";

export declare const CODEX_SYSTEM_CONFIG_PATH: "/etc/codex/config.toml";
export declare const CODEX_API_KEY_VARIABLE: "SHIPBASH_CODEX_API_KEY";
export declare function codexConfig(gateway: AgentServices["model"]): string;
export declare function writeCodexConfig(path: string, gateway: AgentServices["model"]): Promise<void>;
