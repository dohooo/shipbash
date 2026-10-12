import { join } from "node:path";

import { AGENT_SERVICE_VARIABLES } from "@shipbash/contracts/runtime/agent-model.mjs";
import { JOB_API_HOST_VARIABLE } from "@shipbash/contracts/runtime/job-api-contract.mjs";

import type { RuntimeLayout } from "./paths.ts";

const CHILD_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SHIPBASH_DISPATCH_DEADLINE_AT",
  "SHIPBASH_AUTH_TAKEOVER_TIMEOUT_MS",
  "SHIPBASH_CHROME_TRACE",
  "SHIPBASH_POINTER_CHANNEL",
  "SHIPBASH_STREAM_UPSTREAM_CHANNEL",
  ...Object.values(AGENT_SERVICE_VARIABLES),
  JOB_API_HOST_VARIABLE,
] as const;

/**
 * Next's augmented ProcessEnv requires NODE_ENV, but the sandbox child env
 * starts from an allowlist that omits it on purpose. Emptying a copy of a real
 * environment yields a blank of the same type for the allowlist to fill in its
 * own order.
 */
function emptyChildEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const key of Object.keys(environment)) delete environment[key];
  return environment;
}

export function childEnvironment(
  base: NodeJS.ProcessEnv,
  layout: RuntimeLayout,
  encryptionKey: string,
  humanAuthPassword: string,
  inputPath: string,
  repositoryRoot?: string,
): NodeJS.ProcessEnv {
  const child = emptyChildEnvironment(base);
  for (const key of CHILD_ENVIRONMENT_KEYS) {
    if (base[key] !== undefined) child[key] = base[key];
  }
  child.HOME = layout.homeDirectory;
  child.CHROME_BIN = "/usr/bin/chromium";
  child.AGENT_BROWSER_SOCKET_DIR = "/run/agent-browser";
  child.AGENT_BROWSER_CONTENT_BOUNDARIES = "true";
  child.AGENT_BROWSER_MAX_OUTPUT = "20000";
  child.AGENT_BROWSER_AUTOSAVE_INTERVAL_MS = "0";
  child.AGENT_BROWSER_ENCRYPTION_KEY = encryptionKey;
  child.SHIPBASH_HUMAN_AUTH_PASSWORD = humanAuthPassword;
  child.SHIPBASH_RUNTIME_ROOT = layout.root;
  child.SHIPBASH_RUNTIME_DIRECTORY = layout.runtimeDirectory;
  child.SHIPBASH_INPUT_PATH = inputPath;
  child.SHIPBASH_OUTPUT_ROOT = layout.outputDirectory;
  child.SHIPBASH_CONTROL_ROOT = layout.controlDirectory;
  child.SHIPBASH_PI_SESSION_ROOT = join(layout.controlDirectory, "pi-session");
  child.SHIPBASH_AUTH_ROOT = layout.authDirectory;
  child.SHIPBASH_WORK_DIRECTORY = layout.workDirectory;
  child.SHIPBASH_HOME_DIRECTORY = layout.homeDirectory;
  child.SHIPBASH_TRUSTED_ACCESS_PATH = join(layout.trustedAccessDirectory, "config.json");
  child.SHIPBASH_TRUSTED_ACCESS_CONSUMED_PATH = join(
    layout.controlDirectory,
    "trusted-access-consumed",
  );
  if (repositoryRoot) child.SHIPBASH_REPOSITORY_ROOT = repositoryRoot;
  return child;
}
