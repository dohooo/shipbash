// Thin entry for the host Activity runtime, which lives in
// ./activity-runtime/. Importers (dispatch-worker, vercel-sandbox-runtime,
// api/views, service shards) keep this path; the directory is the map:
// input validation, docker-arg building, NDJSON event parsing, result
// validation, and the container lifecycle each live in their own module.
export {
  resultStatus,
  type ActivityDockerRunResult,
} from "./activity-runtime/container.ts";
export {
  SHIPBASH_ACTIVITY_ID_LABEL,
  SHIPBASH_ACTIVITY_KIND_LABEL,
  buildActivityDockerRunArgs,
} from "./activity-runtime/docker-args.ts";
export {
  ActivityNdjsonParser,
  type ActivityRuntimeEvent,
} from "./activity-runtime/events.ts";
export {
  activityInputForContainer,
  validateActivityRuntimeInput,
  type ActivityRuntimeInput,
} from "./activity-runtime/input.ts";
export { redactActivityRuntimeValue } from "./activity-runtime/redaction.ts";
export {
  readActivityResultFile,
  validateActivityAgentResult,
  type ActivityAgentResult,
  type ActivityProposalCandidate,
} from "./activity-runtime/result.ts";
export {
  runActivityInDocker,
  type ActivityRuntimeOptions,
} from "./activity-runtime/run.ts";
