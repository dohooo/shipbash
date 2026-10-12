import "server-only";

/**
 * Handing a live browser to the person who owns the product, so they can sign
 * in to it themselves, and picking the work back up when they are done.
 *
 * The four operations are the whole contract: start a viewer in a Sandbox
 * made for this handoff and hold the Project's slot, look one up without
 * starting anything, promote what the browser captured into the sealed store
 * and resume the waiting run or Activity (or, when the capture is not the
 * product's sign-in yet, open a fresh viewer to finish in), or throw the
 * capture away and cancel the target. The Sandbox is deleted whichever way
 * the handoff ends.
 * Each operation names the stage it is on, so a failure says where it
 * happened rather than only what went wrong.
 */
import type { ActorStore } from "@shipbash/control-plane/store/actor-store";
import type { HumanAuthGateway } from "@shipbash/control-plane/api";
import { decryptAgentBrowserState } from "@shipbash/control-plane/docker-runtime/auth-state";
import { SignInCaptureFailed, SignInCaptureRefused } from "@shipbash/control-plane/human-auth/candidate";
import { signInCaptureAnswer } from "@shipbash/control-plane/service/sign-in-capture-answer";
import type { TargetAuthHandoffAccess } from "@shipbash/control-plane/store/target-auth-handoffs";
import type { TargetAuthStateAccess } from "@shipbash/control-plane/store/target-auth-state";
import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import { ensureRuntime, type RuntimeBundle } from "@shipbash/control-plane/vercel-sandbox-dispatch/runtime-bundle";

import { isRecord } from "./is-record";
import {
  HANDOFF_NOT_ACTIVE,
  claimHandoff,
  ownedHandoff,
  releaseHandoff,
  sameTarget,
} from "./production-human-auth-claim";
import {
  handoffSandboxName,
  productionTarget,
  requiredText,
  viewerPassword,
  viewerUrl,
  type ScopedAuthInput,
} from "./production-human-auth-identity";
import {
  AUTH_ROOT,
  CANDIDATE_PATH,
  CANDIDATE_READY_PATH,
  ENCRYPTION_KEY_PATH,
  HANDOFF_TIMEOUT_MS,
} from "./production-human-auth-paths";
import {
  discardSandbox,
  sandboxHttpStatus,
  stopCommand,
  type ProductionHumanAuthSandbox,
  type ProductionHumanAuthSandboxFactory,
} from "./production-human-auth-sandbox";
import { seedAuthDirectory, startViewer } from "./production-human-auth-viewer";
import {
  liveSandbox,
  resolveSandboxDependencies,
  type ResolvedSandboxDependencies,
} from "./production-sandbox-slot";

interface ProductionHumanAuthDependencies {
  store: Pick<
    ActorStore,
    | "resumeSuiteRunAfterAuth"
    | "resumeActivityAfterAuth"
    | "requestSuiteRunCancellation"
    | "cancelActivity"
    | "getSuiteRunStatus"
    | "getActivityStatus"
  >;
  /** Where the Project's sign-in is kept: what the viewer continues from, and where the promoted capture goes. */
  authState: Pick<TargetAuthStateAccess, "readForProject" | "saveForProject">;
  /** The Project's one handoff at a time. */
  handoffs: TargetAuthHandoffAccess;
  actorSigningSecret: string;
  onWorkAvailable(): void | Promise<void>;
  sandboxFactory?: ProductionHumanAuthSandboxFactory;
  /** The runner image every handoff Sandbox is created from; SHIPBASH_RUNNER_IMAGE otherwise. */
  runnerImage?: string;
  /** The release's code layer; null runs the code the image booted with. */
  runtimeBundle?: RuntimeBundle | null;
}

type Resolved = ResolvedSandboxDependencies<ProductionHumanAuthDependencies>;

function reportHandoffFailure(stage: string, error: unknown): void {
  const detail = error instanceof Error
    ? { name: error.name, message: error.message, status: sandboxHttpStatus(error) }
    : { name: typeof error, message: "Unknown authentication handoff failure.", status: null };
  console.error("[shipbash:human-auth] Authentication handoff failed.", { stage, ...detail });
}

/** The viewer for one handoff: a Sandbox created from the image, given the release and the saved sign-in, its browser started. */
async function openViewer(
  resolved: Resolved,
  input: ScopedAuthInput & { productionUrl: string },
  password: string,
  atStage: (stage: string) => void,
): Promise<string> {
  const { dependencies, factory } = resolved;
  atStage("create_sandbox");
  const sandbox = await factory.create({
    name: handoffSandboxName(input.projectId),
    image: dependencies.runnerImage ?? hostedConfiguration().hosted.runnerImage,
    timeout: HANDOFF_TIMEOUT_MS,
    ports: [6080],
    persistent: false,
  });
  try {
    atStage("install_runtime");
    const runtimeDirectory = await ensureRuntime(sandbox, resolved.runtimeBundle);
    atStage("seed_sign_in");
    await seedAuthDirectory(
      sandbox,
      await dependencies.authState.readForProject(input.teamId, input.projectId, input.productionUrl),
    );
    atStage("start_viewer");
    const commandId = await startViewer(sandbox, input, runtimeDirectory, password);
    atStage("record_viewer");
    await dependencies.handoffs.attachViewer(input, { sandboxName: sandbox.name, commandId });
    return viewerUrl(sandbox, password);
  } catch (error) {
    await discardSandbox(sandbox);
    throw error;
  }
}

async function startHandoff(
  dependencies: ProductionHumanAuthDependencies,
  secret: string,
  input: ScopedAuthInput & { productionUrl: string },
): Promise<{ waiting: boolean; authViewerUrl: string }> {
  let stage = "validate_target";
  let claimed = false;
  try {
    const target = productionTarget(input.productionUrl);
    const resolved = await resolveSandboxDependencies(dependencies);
    const password = viewerPassword(secret, input);
    stage = "claim_handoff";
    const running = await claimHandoff({ handoffs: dependencies.handoffs, factory: resolved.factory, store: dependencies.store }, input);
    if (running) return { waiting: true, authViewerUrl: viewerUrl(running, password) };
    claimed = true;
    const authViewerUrl = await openViewer(resolved, { ...input, productionUrl: target }, password, (next) => {
      stage = next;
    });
    return { waiting: true, authViewerUrl };
  } catch (error) {
    reportHandoffFailure(stage, error);
    if (claimed) await dependencies.handoffs.release(input.projectId).catch(() => undefined);
    throw error;
  }
}

async function peekViewer(
  dependencies: ProductionHumanAuthDependencies,
  secret: string,
  input: ScopedAuthInput,
): Promise<string | null> {
  const handoff = await dependencies.handoffs.read(input.projectId);
  if (!handoff || !sameTarget(handoff, input)) return null;
  const { factory } = await resolveSandboxDependencies(dependencies);
  const sandbox = await liveSandbox(factory, handoff);
  return sandbox ? viewerUrl(sandbox, viewerPassword(secret, input)) : null;
}

async function jsonFileIn(sandbox: ProductionHumanAuthSandbox, path: string): Promise<Record<string, unknown> | null> {
  const raw = await sandbox.readTextFile(path).catch(() => null);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Why the capture could not be promoted, in the container's own words. The
 * ruler's refusal is the person's to fix and is repeated as written
 * (candidate.failure.json, derived from candidate.scope.json); an
 * infrastructure failure, or a capture that recorded nothing, names its
 * reason.
 */
async function promotionFailure(sandbox: ProductionHumanAuthSandbox): Promise<SignInCaptureRefused | SignInCaptureFailed> {
  const failure = await jsonFileIn(sandbox, `${AUTH_ROOT}/candidate.failure.json`);
  if (failure && typeof failure.message === "string") {
    return failure.kind === "refusal"
      ? new SignInCaptureRefused(failure.message)
      : new SignInCaptureFailed(`The authenticated browser could not capture the sign-in: ${failure.message}`);
  }
  const scope = await jsonFileIn(sandbox, `${AUTH_ROOT}/candidate.scope.json`);
  if (scope && scope.product === false && typeof scope.reason === "string") {
    return new SignInCaptureRefused(
      `The private browser's capture was not the product's sign-in (${scope.reason.replaceAll("_", " ")}).`,
    );
  }
  return new SignInCaptureFailed("The authenticated browser state could not be promoted.");
}

/**
 * The captured state, opened with the Sandbox's own key and sealed on the
 * Project's profile. A capture the viewer did not mark ready is not kept,
 * and the error says why; a save that fails fails the handoff: a sign-in only
 * the Sandbox holds is one the next task cannot receive.
 */
async function saveCapturedState(
  sandbox: ProductionHumanAuthSandbox,
  dependencies: ProductionHumanAuthDependencies,
  input: ScopedAuthInput & { productionUrl: string },
): Promise<void> {
  const [ready, sealed, key] = await Promise.all([
    sandbox.readTextFile(CANDIDATE_READY_PATH).catch(() => null),
    sandbox.readFile(CANDIDATE_PATH).catch(() => null),
    sandbox.readTextFile(ENCRYPTION_KEY_PATH).catch(() => null),
  ]);
  if (!ready || !sealed?.byteLength) throw await promotionFailure(sandbox);
  if (!key?.trim()) throw new SignInCaptureFailed("The promoted authentication state could not be read from the Sandbox.");
  const state = decryptAgentBrowserState(sealed, key.trim());
  await dependencies.authState.saveForProject(
    input.teamId,
    input.projectId,
    input.productionUrl,
    JSON.stringify(state),
  );
}

/** Stop the viewer and keep what it captured, or say why it could not be kept; the Sandbox goes either way. */
async function captureAndRelease(
  resolved: Resolved,
  handoff: { sandboxName: string; commandId: string },
  input: ScopedAuthInput & { productionUrl: string },
): Promise<void> {
  const { dependencies, factory } = resolved;
  const sandbox = await factory.get(handoff.sandboxName);
  if (!sandbox) {
    await dependencies.handoffs.release(input.projectId);
    throw new Error(HANDOFF_NOT_ACTIVE);
  }
  try {
    const finished = await stopCommand(await sandbox.getCommand(handoff.commandId), "SIGTERM");
    if (finished?.exitCode !== 0) throw new SignInCaptureFailed("The authenticated browser did not close cleanly.");
    await saveCapturedState(sandbox, dependencies, input);
  } finally {
    await discardSandbox(sandbox);
    await dependencies.handoffs.release(input.projectId);
  }
}

async function completeHandoff(
  dependencies: ProductionHumanAuthDependencies,
  secret: string,
  input: ScopedAuthInput & { productionUrl: string },
): Promise<{ resumed: boolean }> {
  const target = productionTarget(input.productionUrl);
  const handoff = await ownedHandoff(dependencies.handoffs, input);
  if (!handoff) throw new Error(HANDOFF_NOT_ACTIVE);
  try {
    await captureAndRelease(await resolveSandboxDependencies(dependencies), handoff, { ...input, productionUrl: target });
  } catch (error) {
    // A refusal reopens a viewer the way Take control opens one: the refused capture's Sandbox is already gone.
    throw await signInCaptureAnswer(error, async () => (await startHandoff(dependencies, secret, input)).authViewerUrl);
  }

  const resumed = input.targetKind === "run"
    ? await dependencies.store.resumeSuiteRunAfterAuth(
        input.actor,
        input.teamId,
        input.projectId,
        input.targetId,
      )
    : await dependencies.store.resumeActivityAfterAuth(
        input.actor,
        input.teamId,
        input.projectId,
        input.targetId,
      ).then(() => true);
  if (resumed) await dependencies.onWorkAvailable();
  return { resumed };
}

async function cancelHandoff(
  dependencies: ProductionHumanAuthDependencies,
  input: ScopedAuthInput,
): Promise<void> {
  const handoff = await dependencies.handoffs.read(input.projectId);
  if (handoff && sameTarget(handoff, input)) {
    // Nothing the viewer captured is kept: the Sandbox goes with it.
    await releaseHandoff({ handoffs: dependencies.handoffs, factory: (await resolveSandboxDependencies(dependencies)).factory }, handoff);
  }
  if (input.targetKind === "run") {
    await dependencies.store.requestSuiteRunCancellation(
      input.actor,
      input.teamId,
      input.projectId,
      input.targetId,
    );
  } else {
    await dependencies.store.cancelActivity(
      input.actor,
      input.teamId,
      input.projectId,
      input.targetId,
      "Authentication handoff was canceled.",
    );
  }
}

export function createProductionHumanAuthGateway(
  dependencies: ProductionHumanAuthDependencies,
): HumanAuthGateway {
  const secret = requiredText(dependencies.actorSigningSecret, "actorSigningSecret");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("actorSigningSecret must contain at least 32 bytes.");
  }

  return {
    status: (input) => startHandoff(dependencies, secret, input),
    peek: (input) => peekViewer(dependencies, secret, input),
    complete: (input) => completeHandoff(dependencies, secret, input),
    cancel: (input) => cancelHandoff(dependencies, input),
  };
}
