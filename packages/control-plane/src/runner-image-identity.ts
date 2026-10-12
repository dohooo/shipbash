/**
 * The runner image's identity: the tag, the build inputs and their digest,
 * the inspection of a built image, and the build-or-verify step the dev stack
 * and the Runner run before they start a container from it.
 */
export {
  ensureRunnerImage,
  expectedRunnerBuildDigest,
  inspectRunnerImageIdentity,
  runnerBuildDigest,
} from "./init-browser-image.ts";
export type { RunnerImageIdentity } from "./init-browser-image.ts";
// The build-input list lives in src/runner-build-inputs.ts; re-exported here
// so digest callers keep their single import point.
export { RUNNER_BUILD_INPUTS } from "./runner-build-inputs.ts";
