// The Codex CLI configuration every journey shell runs with: Codex's system
// layer, /etc/codex/config.toml, so a Codex that a journey installs answers
// through the deployment's model gateway with the key the shell carries for it
// (terminal-shell.mjs), and has nothing to sign in to. The system layer sits below the user's
// ~/.codex/config.toml: a product step that writes its own file (registering
// an MCP server, say) merges over it, and one that deletes that file to start
// from a fresh machine leaves this one in place.
//
// The gateway is the deployment's, so the file is written when a runner
// starts, not when the image is built: a local container mounts the copy its
// host wrote (docker-args.ts), and a Sandbox's dispatch writes it as root
// before the runner's user starts (vercel-sandbox-runtime/dispatch.ts).
import { chmod, writeFile } from "node:fs/promises";

import { AGENT_MODEL } from "@shipbash/contracts/runtime/agent-model.mjs";

/** Where Codex reads its system layer. */
export const CODEX_SYSTEM_CONFIG_PATH = "/etc/codex/config.toml";
/** The variable a journey shell holds the gateway key in, read by this configuration alone. */
export const CODEX_API_KEY_VARIABLE = "SHIPBASH_CODEX_API_KEY";

// TOML basic strings take JSON's quoting. `service_tier = "fast"` is Codex's
// config name for the gateway's "priority" tier: every Codex release with the
// setting accepts it and sends it as the request value "priority", while a
// release before 0.131 rejects "priority" there and with it the whole file.
// `mcp_optional_startup_grace_ms = 0` makes Codex wait for each MCP server, up
// to its own startup timeout, before its first request; the 1 s default lets
// the fast tier's first turn go out before a slow server (an `npx` bridge, say)
// has registered its tools, and the model then reports them missing.
/**
 * The configuration for the deployment's model gateway.
 * @param {import("@shipbash/contracts/runtime/agent-model.mjs").AgentServices["model"]} gateway
 */
export function codexConfig(gateway) {
  return [
    `model = ${JSON.stringify(AGENT_MODEL)}`,
    'model_provider = "shipbash"',
    ...(gateway.serviceTier === "priority" ? ['service_tier = "fast"'] : []),
    "mcp_optional_startup_grace_ms = 0",
    "",
    "[model_providers.shipbash]",
    'name = "ShipBash"',
    `base_url = ${JSON.stringify(gateway.baseUrl)}`,
    `env_key = ${JSON.stringify(CODEX_API_KEY_VARIABLE)}`,
    'wire_api = "responses"',
    "",
  ].join("\n");
}

/** Writes that configuration where `path` names, readable by every uid. */
export async function writeCodexConfig(path, gateway) {
  await writeFile(path, codexConfig(gateway));
  await chmod(path, 0o644);
}
