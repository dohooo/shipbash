// The mount points both runners share: the SHIPBASH_* container contract and
// the paths derived from it. Each runner's environment.mjs takes them from
// here and adds its own.
import { isAbsolute, join } from "node:path";

import { agentPointerChannelPath } from "./agent-pointer.mjs";

// A failing child's last redacted words, bounded so a chatty process can
// never turn a diagnostic into a payload.
export const STDERR_TAIL_BYTES = 2_000;

export function absoluteEnvironmentPath(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value;
}

/**
 * The shared mount points, read and validated in this order: of two bad
 * variables, the earlier one is the one refused.
 * @param {string} inputFile The runner's input file under `input/`.
 */
export function containerPaths(inputFile) {
  const RUNTIME_ROOT = absoluteEnvironmentPath("SHIPBASH_RUNTIME_ROOT", "/shipbash");
  const INPUT_PATH = absoluteEnvironmentPath("SHIPBASH_INPUT_PATH", join(RUNTIME_ROOT, `input/${inputFile}`));
  const OUTPUT_ROOT = absoluteEnvironmentPath("SHIPBASH_OUTPUT_ROOT", join(RUNTIME_ROOT, "output"));
  const CONTROL_ROOT = absoluteEnvironmentPath("SHIPBASH_CONTROL_ROOT", join(RUNTIME_ROOT, "control"));
  const AUTH_ROOT = absoluteEnvironmentPath("SHIPBASH_AUTH_ROOT", join(RUNTIME_ROOT, "auth"));
  const RUNTIME_DIRECTORY = absoluteEnvironmentPath("SHIPBASH_RUNTIME_DIRECTORY", join(RUNTIME_ROOT, "runtime"));
  const HOME_DIRECTORY = absoluteEnvironmentPath("SHIPBASH_HOME_DIRECTORY", join(RUNTIME_ROOT, "home"));
  const WORK_DIRECTORY = absoluteEnvironmentPath("SHIPBASH_WORK_DIRECTORY", join(RUNTIME_ROOT, "work"));
  const REPOSITORY_ROOT = absoluteEnvironmentPath("SHIPBASH_REPOSITORY_ROOT", join(RUNTIME_ROOT, "repository"));
  return {
    RUNTIME_ROOT,
    INPUT_PATH,
    OUTPUT_ROOT,
    CONTROL_ROOT,
    AUTH_ROOT,
    AUTH_STATE_PATH: join(AUTH_ROOT, "state.json"),
    AUTH_CANDIDATE_PATH: join(AUTH_ROOT, "candidate.json"),
    AUTH_CANDIDATE_READY_PATH: join(AUTH_ROOT, "candidate.ready"),
    CANCEL_PATH: join(CONTROL_ROOT, "cancel"),
    RUNTIME_DIRECTORY,
    HOME_DIRECTORY,
    WORK_DIRECTORY,
    REPOSITORY_ROOT,
    // The wrapper normally provides the channel path; deriving the same
    // default keeps pointer capture working when only the runner is updated.
    POINTER_CHANNEL_PATH: process.env.SHIPBASH_POINTER_CHANNEL?.trim() || agentPointerChannelPath(WORK_DIRECTORY),
  };
}
