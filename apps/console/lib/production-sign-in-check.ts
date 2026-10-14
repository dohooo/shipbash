import "server-only";

/**
 * Checking a saved password on the hosted console: the auto-login leg, in a
 * browser Sandbox of its own.
 *
 * The local service borrows the Project's takeover browser and serves the
 * credential from its own process (control-plane
 * service/sign-in-verify-lane.ts). The console holds the keyring but no
 * process a Sandbox can reach, so the check's Sandbox gets a root side
 * (runner sign-in-check.mjs) that holds the one credential while the check
 * runs and serves it to the leg the way every run's broker does.
 *
 * The browser opens blank on the login page, never on the Project's saved
 * session, so the leg cannot sign that session out on its way in. The
 * Sandbox goes when the check does, however it ends.
 */
import { modelContractFor } from "@shipbash/contracts/model-contract";
import { LANE_BROWSER_CDP_URL_PATH } from "@shipbash/contracts/runtime/browser-lane.mjs";
import { decryptAgentBrowserState } from "@shipbash/control-plane/docker-runtime/auth-state";
import { authStateVersion } from "@shipbash/control-plane/init-browser-auth-state";
import type {
  SignInLoginCredential,
  SignInVerifyLane,
  SignInVerifyRequest,
  SignInVerifyResult,
} from "@shipbash/control-plane/service/sign-in-verify-lane";
import { SIGN_IN_VERIFY_TIMEOUT_MS } from "@shipbash/control-plane/service/sign-in-timing";
import type { RuntimeBundle } from "@shipbash/control-plane/vercel-sandbox-dispatch/runtime-bundle";
import { SANDBOX_AGENT_GID, SANDBOX_AGENT_UID } from "@shipbash/control-plane/vercel-sandbox-dispatch/sandbox-agent-command";
import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import { sandboxAgentEnvironment } from "@shipbash/control-plane/vercel-sandbox-network-policy";
import { signInLegEnvironment, signInVerifyOutcomeFrom } from "@shipbash/runner/runtime/sign-in-leg.mjs";

import {
  discardSandbox,
  stopCommand,
  type ProductionHumanAuthSandbox,
  type ProductionHumanAuthSandboxFactory,
  type SandboxCommandResult,
} from "./production-human-auth-sandbox";
import { mintToken, openTakeoverBrowser, type OpenedTakeoverBrowser, projectDigest } from "./production-sign-in-takeover-browser";

/** The check's own corner of its Sandbox: the root side's input and the leg's log, beside the leg's own root. */
const CHECK_ROOT = "/shipbash/check";
const CHECK_INPUT_PATH = `${CHECK_ROOT}/input.json`;
const CHECK_LOG_PATH = `${CHECK_ROOT}/leg.log`;
const LEG_ROOT = `${CHECK_ROOT}/leg`;
/** Where the leg seals the session it made: its control root's sign-in-login.json.enc (runner suite-runner/environment.mjs). */
const LEG_SESSION_PATH = `${LEG_ROOT}/control/sign-in-login.json.enc`;
/** Time past the leg's deadline for the root side to stop it and write its log down. */
const SETTLE_GRACE_MS = 15_000;
/** A Sandbox outlives its check by a little, so one a dead Function left behind does not linger. */
const CHECK_SANDBOX_TIMEOUT_MS = SIGN_IN_VERIFY_TIMEOUT_MS + 2 * 60_000;

const PROVED_NOTHING: SignInVerifyResult = { verified: false, label: null, reason: "unknown" };

/** What a check opens its browser with. */
interface SignInCheckSandboxes {
  factory: ProductionHumanAuthSandboxFactory;
  image: string;
  runtimeBundle: RuntimeBundle | null;
  /** The console's origin: the one Origin the browser's stream accepts. The check never hands its stream out. */
  publicOrigin: string;
}

/** One check's facts, gathered before its browser opens. */
interface PasswordCheck {
  request: SignInVerifyRequest;
  credential: SignInLoginCredential;
  signInPageUrl: string;
  deadline: number;
}

/**
 * What the root side is handed, in a file only root can read: the account it
 * serves, the leg's one-shot config, and the leg's environment.
 */
function checkInput(check: PasswordCheck, browser: OpenedTakeoverBrowser, browserCdpUrl: string): string {
  const { request, credential, signInPageUrl } = check;
  return JSON.stringify({
    agent: { uid: SANDBOX_AGENT_UID, gid: SANDBOX_AGENT_GID },
    timeoutMs: Math.max(check.deadline - Date.now(), 1_000),
    signIn: {
      id: request.signInId,
      pageUrl: signInPageUrl,
      credential: { email: credential.email, password: credential.password, totpSecret: credential.totpSecret },
    },
    leg: {
      config: {
        productionUrl: request.productionUrl,
        signInPageUrl,
        encryptionKey: browser.encryptionKey,
        browserCdpUrl,
        modelContract: modelContractFor("sign_in"),
      },
      environment: {
        ...signInLegEnvironment({ mode: "sign-in-login", projectHash: projectDigest(request.projectId) }),
        // Placeholders: the check's Sandbox firewall adds the keys.
        ...sandboxAgentEnvironment(hostedConfiguration()),
      },
    },
  });
}

/** Waits for the root side to finish, and stops it when it runs past the check's deadline. */
async function waitForCheck(command: SandboxCommandResult, until: number): Promise<void> {
  try {
    await command.wait({ signal: AbortSignal.timeout(Math.max(until - Date.now(), 0)) });
  } catch {
    await stopCommand(command, "SIGKILL");
  }
}

/**
 * The leg's run in an open browser, read back the way the local lane reads
 * a container: the outcome off the leg's log, and on a pass the session it
 * sealed under the browser's key, opened here and handed back as the state
 * itself — what the hosted `promote` keeps.
 */
async function runLeg(browser: OpenedTakeoverBrowser, check: PasswordCheck): Promise<SignInVerifyResult> {
  const { sandbox } = browser;
  const browserCdpUrl = (await sandbox.readTextFile(LANE_BROWSER_CDP_URL_PATH))?.trim();
  if (!browserCdpUrl) throw new Error("The check's browser did not say where it listens.");
  const prepared = await sandbox.runCommand({ cmd: "mkdir", args: ["-p", CHECK_ROOT] });
  if (prepared.exitCode !== 0) throw new Error("The check's Sandbox could not be prepared.");
  await sandbox.writeFiles([{ path: CHECK_INPUT_PATH, content: checkInput(check, browser, browserCdpUrl), mode: 0o600 }]);
  const command = await sandbox.runCommand({
    cmd: "node",
    args: [`${browser.runtimeDirectory}/sign-in-check.mjs`, CHECK_INPUT_PATH, CHECK_LOG_PATH],
    env: { SHIPBASH_RUNTIME_ROOT: LEG_ROOT, SHIPBASH_RUNTIME_DIRECTORY: browser.runtimeDirectory },
    detached: true,
  });
  await waitForCheck(command, check.deadline + SETTLE_GRACE_MS);
  // Silence is not a pass: a leg that never said leaves the sign-in where a failed one does.
  const outcome = signInVerifyOutcomeFrom((await sandbox.readTextFile(CHECK_LOG_PATH)) ?? "");
  if (!outcome?.verified) return outcome ?? PROVED_NOTHING;
  const sealed = await sandbox.readFile(LEG_SESSION_PATH);
  if (!sealed?.byteLength) return PROVED_NOTHING;
  const state = Buffer.from(JSON.stringify(decryptAgentBrowserState(sealed, browser.encryptionKey)));
  return { ...outcome, state, stateVersion: authStateVersion(state) };
}

/**
 * Checks one saved password. Never throws: a check that could not run has
 * proved nothing, and says so in the word for "we do not know".
 */
async function checkSavedPassword(
  sandboxes: () => Promise<SignInCheckSandboxes>,
  request: SignInVerifyRequest,
): Promise<SignInVerifyResult> {
  // Only a password is checked here; the gateway refuses every other way in
  // before a row moves, so a session never arrives.
  const { credential } = request;
  if (!credential) return PROVED_NOTHING;
  const deadline = Date.now() + SIGN_IN_VERIFY_TIMEOUT_MS;
  let sandbox: ProductionHumanAuthSandbox | null = null;
  try {
    const { factory, image, runtimeBundle, publicOrigin } = await sandboxes();
    const signInPageUrl = credential.loginUrl ?? request.productionUrl;
    const browser = await openTakeoverBrowser(factory, {
      projectId: request.projectId,
      image,
      runtimeBundle,
      timeoutMs: CHECK_SANDBOX_TIMEOUT_MS,
      savedState: null,
      controlToken: mintToken(),
      startUrl: signInPageUrl,
      streamToken: mintToken(),
      allowedOrigin: publicOrigin,
    });
    sandbox = browser.sandbox;
    return await runLeg(browser, { request, credential, signInPageUrl, deadline });
  } catch (error) {
    console.error("[sign-ins] the hosted password check could not run:", error instanceof Error ? error.message : String(error));
    return PROVED_NOTHING;
  } finally {
    if (sandbox) await discardSandbox(sandbox);
  }
}

/** The hosted lane: password checks only, each in its own Sandbox, with no stream for the page to watch. */
export function createProductionSignInVerifyLane(sandboxes: () => Promise<SignInCheckSandboxes>): SignInVerifyLane {
  return {
    verify: (request) => checkSavedPassword(sandboxes, request),
    streamUrl: () => null,
  };
}
