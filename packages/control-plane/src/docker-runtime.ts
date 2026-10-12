// Thin entry for the host Suite (Docker) runtime, which lives in
// ./docker-runtime/. Importers (dispatch-worker, vercel-sandbox-runtime,
// init-browser, service shards) keep this path; the directory is the
// map: suite-input validation, docker-arg building, NDJSON event parsing,
// auth-state encryption, container reconciliation, and the run lifecycle
// each live in their own module.
export {
  encryptAgentBrowserState,
  ensureAuthEncryptionKey,
} from "./docker-runtime/auth-state.ts";
export {
  DEFAULT_RUNNER_MEMORY_LIMIT,
  SHIPBASH_CONTAINER_ROLE_LABEL,
  SHIPBASH_MANAGED_LABEL,
  SHIPBASH_PROJECT_HASH_LABEL,
  SHIPBASH_SUITE_RUN_ID_LABEL,
  buildDockerRunArgs,
  resolveRunAsIds,
  resolveRunnerMemoryLimit,
} from "./docker-runtime/docker-args.ts";
export {
  NdjsonEventParser,
  type DockerRuntimeEvent,
} from "./docker-runtime/events.ts";
export {
  suiteInputForContainer,
  validateSuiteInput,
  type DockerSuiteInput,
} from "./docker-runtime/input.ts";
export {
  mapContainerExit,
  reconcileProjectContainers,
  waitForContainerId,
  writeCancelSentinel,
} from "./docker-runtime/reconcile.ts";
export {
  redactRuntimeStderr,
  redactRuntimeValue,
} from "./docker-runtime/redaction.ts";
export {
  runSuiteInDocker,
  type DockerRuntimeOptions,
  type DockerSuiteRunResult,
} from "./docker-runtime/run.ts";
