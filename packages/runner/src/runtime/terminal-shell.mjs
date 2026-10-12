/**
 * What the agent's shell is given: its environment. A Codex CLI the shell runs
 * answers through the deployment's model gateway with the key it is handed
 * here; its configuration is the system layer the host placed
 * (codex-config.mjs), not HOME's.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_SERVICE_VARIABLES } from "@shipbash/contracts/runtime/agent-model.mjs";

import { CODEX_API_KEY_VARIABLE } from "./codex-config.mjs";

/** Where the shell finds its stand-ins first: agent-browser (refuses) and xdg-open (spools). */
export const TERMINAL_BIN_DIRECTORY = fileURLToPath(new URL("./terminal-bin", import.meta.url));
/** What the interactive shell reads at start after /etc/bash.bashrc: the user's ~/.bashrc, then the lane's prompt. */
export const TERMINAL_RC_FILE = fileURLToPath(new URL("./terminal-bashrc", import.meta.url));

// The shell is the product's, not the runner's. The image sets
// NODE_ENV=production for the dispatch, and a product scaffold inheriting it
// has `npm install` skip devDependencies and `npm start` fail on a missing
// tsx (a target product). agent-browser is the harness's alone: a shell
// that could run it would launch a Chromium of its own, or, pointed at the
// harness's browser, drive it where no step is recorded. So the shell gets
// none of agent-browser's settings, and its PATH finds the stand-in first.
// It runs in C.UTF-8, glibc's built-in UTF-8 locale, whatever the process
// that opened it had: under the POSIX default less printed `·` as <C2><B7>
// and vim decoded multibyte text as Latin-1. A program that opens a URL —
// through xdg-open on the PATH or through BROWSER — reaches the run's
// browser (terminal-open-spool.mjs). The shell's user is unprivileged in
// both runtimes and /usr/local is root's, so npm's global prefix is under
// HOME with its bin on PATH: `npm install -g`, which product install lines
// run, failed with EACCES in a Sandbox, which never reads the image's ENV.
// The model gateway's variables carry OpenAI's names, which OpenAI's SDKs and
// most AI tools read unasked: a product in the shell would answer through the
// gateway on ShipBash's key. So the shell gets none of them, and Codex gets
// the key under a name only its system layer reads.
// Everything else is inherited as is.
const { modelBaseUrl, modelApiKey, modelServiceTier } = AGENT_SERVICE_VARIABLES;
const GATEWAY_VARIABLES = new Set([modelBaseUrl, modelApiKey, modelServiceTier]);

export function shellEnvironment(homeDirectory, openDirectory) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      name !== "NODE_ENV" && !name.startsWith("AGENT_BROWSER_") && !GATEWAY_VARIABLES.has(name)),
  );
  const npmPrefix = join(homeDirectory, ".npm-global");
  return {
    ...inherited,
    PATH: [TERMINAL_BIN_DIRECTORY, join(npmPrefix, "bin"), inherited.PATH].filter(Boolean).join(":"),
    HOME: homeDirectory,
    NPM_CONFIG_PREFIX: npmPrefix,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    BROWSER: join(TERMINAL_BIN_DIRECTORY, "xdg-open"),
    SHIPBASH_TERMINAL_OPEN_DIRECTORY: openDirectory,
    [CODEX_API_KEY_VARIABLE]: process.env[modelApiKey],
  };
}
