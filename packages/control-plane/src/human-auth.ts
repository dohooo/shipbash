// The human takeover session lifecycle: start an isolated auth-only container
// behind a loopback noVNC viewer, stop it, and read back the sign-in state its
// CDP capture left behind. The mechanics live in ./human-auth/ — the input
// validation, the session naming, the Trusted Production access runtime, the
// Docker calls, the three startup waits, the captured candidate and the
// container argv each in their own module.
import { RUNNER_IMAGE } from "./runner-image.ts";
import { rm } from "node:fs/promises";

import { ensureCanonicalDefaultAuthPaths } from "./auth-path.ts";
import {
  releaseTrustedAccessFileWhenConsumed,
  type TrustedAccessRuntimeConfig,
} from "./trusted-access-runtime.ts";
import {
  capturedCandidate,
  clearCapturedCandidate,
  judgeCapturedSignIn,
  SignInCaptureFailed,
  SignInCaptureRefused,
} from "./human-auth/candidate.ts";
import { HUMAN_AUTH_PASSWORD_ENV, humanAuthContainerArgs } from "./human-auth/container-args.ts";
import { POLL_INTERVAL_MS, inspectRunning, missingContainer, run } from "./human-auth/docker.ts";
import { authSessionHash, humanAuthContainerName, humanAuthPassword } from "./human-auth/naming.ts";
import {
  waitForPublishedViewerPort,
  waitForRunnerReady,
  waitForViewer,
} from "./human-auth/readiness.ts";
import {
  prepareTrustedAccessRuntime,
  removeTrustedAccessRuntime,
} from "./human-auth/trusted-access.ts";
import {
  dockerBinary,
  validateImage,
  validateProductionUrl,
  validateUserId,
} from "./human-auth/validation.ts";
import { validateIdentifier } from "./docker-runtime/validate.ts";

export { humanAuthContainerName } from "./human-auth/naming.ts";

const DEFAULT_IMAGE = RUNNER_IMAGE;
const VIEWER_PATH = "/vnc.html?autoconnect=1&resize=scale";
const STOP_TIMEOUT_MS = 15_000;

export interface StartHumanAuthSessionOptions {
  sessionId: string;
  projectHash: string;
  stateDirectory: string;
  authDirectory: string;
  productionUrl: string;
  image?: string;
  dockerBinary?: string;
  uid?: number;
  gid?: number;
  trustedAccess?: TrustedAccessRuntimeConfig | null;
  /** Reopening after a refusal: load the refused capture into the fresh viewer so the identity provider stays signed in. */
  preloadRefusedCandidate?: boolean;
}

export interface HumanAuthSession {
  containerName: string;
  viewerUrl: string;
}

export interface StopHumanAuthSessionOptions {
  dockerBinary?: string;
  stateDirectory: string;
  authDirectory: string;
}

export interface CaptureHumanAuthCandidateOptions extends StartHumanAuthSessionOptions {}

export async function startHumanAuthSession(
  options: StartHumanAuthSessionOptions,
): Promise<HumanAuthSession> {
  const containerName = humanAuthContainerName(options.sessionId);
  const projectHash = validateIdentifier(options.projectHash, "projectHash");
  const sessionHash = authSessionHash(options.sessionId);
  const paths = await ensureCanonicalDefaultAuthPaths(
    options.stateDirectory,
    options.authDirectory,
  );
  const authDirectory = paths.authDirectory;
  const productionUrl = validateProductionUrl(options.productionUrl);
  const image = validateImage(options.image ?? DEFAULT_IMAGE);
  const command = dockerBinary(options.dockerBinary);
  const uid = validateUserId(options.uid, "uid", process.getuid?.());
  const gid = validateUserId(options.gid, "gid", process.getgid?.());
  const password = humanAuthPassword();
  const trustedAccessRuntime = await prepareTrustedAccessRuntime(
    authDirectory,
    sessionHash,
    productionUrl,
    options.trustedAccess,
  );
  await clearCapturedCandidate(authDirectory, { preload: options.preloadRefusedCandidate === true });

  // The container name is deterministic, and a force-killed service leaves its
  // previous --rm container running; remove it or `docker run` fails on the
  // name conflict. A live same-name session never reaches this code path.
  await run(command, ["rm", "--force", containerName]);

  const created = await run(command, humanAuthContainerArgs({
    authDirectory,
    containerName,
    gid,
    image,
    projectHash,
    sessionHash,
    trustedAccessRuntime,
    uid,
  }), {
    env: {
      ...process.env,
      SHIPBASH_HUMAN_AUTH_URL: productionUrl,
      [HUMAN_AUTH_PASSWORD_ENV]: password,
    },
  });
  if (created.exitCode !== 0) {
    if (trustedAccessRuntime) {
      await rm(trustedAccessRuntime.runtimeDirectory, { recursive: true, force: true });
    }
    throw new Error(`Docker could not start the human auth container (exit ${created.exitCode}).`);
  }

  let signalContainerClosed: () => void = () => undefined;
  const containerClosed = new Promise<void>((resolvePromise) => {
    signalContainerClosed = resolvePromise;
  });
  const trustedAccessRelease = trustedAccessRuntime
    ? releaseTrustedAccessFileWhenConsumed({
        controlDirectory: trustedAccessRuntime.controlDirectory,
        trustedAccessDirectory: trustedAccessRuntime.trustedAccessDirectory,
        containerClosed,
      })
    : Promise.resolve<"consumed" | "container_closed">("consumed");

  try {
    await waitForRunnerReady(command, containerName);
    const releaseOutcome = await trustedAccessRelease;
    if (trustedAccessRuntime && releaseOutcome !== "consumed") {
      throw new Error("The human auth browser exited before Trusted Production access was ready.");
    }
    const port = await waitForPublishedViewerPort(command, containerName);
    const viewerUrl = `http://127.0.0.1:${port}${VIEWER_PATH}#password=${encodeURIComponent(password)}`;
    await waitForViewer(command, containerName, viewerUrl);
    return { containerName, viewerUrl };
  } catch (error) {
    signalContainerClosed();
    await stopHumanAuthSession(options.sessionId, {
      dockerBinary: command,
      stateDirectory: paths.stateDirectory,
      authDirectory,
    }).catch(() => {});
    await trustedAccessRelease.catch(() => undefined);
    throw error;
  }
}

export async function stopHumanAuthSession(
  sessionId: string,
  options: StopHumanAuthSessionOptions,
): Promise<void> {
  const containerName = humanAuthContainerName(sessionId);
  const command = dockerBinary(options.dockerBinary);
  const running = await inspectRunning(command, containerName);
  if (running === null || running === false) {
    await removeTrustedAccessRuntime(options.authDirectory, sessionId);
    return;
  }

  // The candidate is written on the SIGTERM path, and that walk makes one CDP
  // round trip per open page with a 10s budget each. Ten seconds killed the
  // capture mid-walk on any busy takeover and left an empty candidate — the
  // same symptom as a takeover that captured nothing at all. Thirty matches
  // the runner's own waitForCapturedCandidate budget.
  const stopped = await run(command, ["stop", "--timeout", "30", containerName]);
  if (stopped.exitCode !== 0 && !missingContainer(stopped)) {
    throw new Error("Docker could not stop the human auth container gracefully.");
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await inspectRunning(command, containerName);
    if (state === null || state === false) {
      await removeTrustedAccessRuntime(options.authDirectory, sessionId);
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS));
  }
  throw new Error("The human auth container did not stop within 15 seconds.");
}

export async function captureHumanAuthCandidate(
  options: CaptureHumanAuthCandidateOptions,
): Promise<{ candidatePath: string; stateVersion: string }> {
  const paths = await ensureCanonicalDefaultAuthPaths(options.stateDirectory, options.authDirectory);
  // Disposable viewer profiles have no shared state; the CDP capture is the
  // only producer of sign-in state. Bytes that are not the product's sign-in
  // are refused with words for the person; a capture that never happened is
  // the container's failure, and says so instead of asking them to sign in
  // again.
  const judgement = await judgeCapturedSignIn(paths.authDirectory, new URL(options.productionUrl).origin);
  if (judgement.kind === "refused") throw new SignInCaptureRefused(judgement.message);
  if (judgement.kind === "failed") throw new SignInCaptureFailed(judgement.message);
  const liveCandidate = await capturedCandidate(paths.authDirectory);
  if (!liveCandidate) throw new SignInCaptureFailed(
    "The live sign-in was not captured before the viewer closed. Restart the takeover and complete it again.",
  );
  return liveCandidate;
}
