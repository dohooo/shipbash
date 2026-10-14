/**
 * The verification leg's host side: one throwaway browser per check, and the
 * one-shot delivery of the session it is checking.
 *
 * The leg is deliberately row-less, like the idle browser lane. There is no
 * dispatch job and no runtime session — a container starts (a password check
 * runs the pi sign-in agent in it), says on its own log whether the session got
 * inside the product, and goes. What survives is the sign-in row the caller
 * updates from the outcome, and the audit event beside it.
 *
 * The session is handed over the way Trusted access hands over a credential:
 * written 0600 into a directory bound read-only, taken away as soon as the
 * container says it has read it, and the attempt's own directory removed when
 * the leg ends, however it ends. A password is never handed over: the leg
 * reads it from a credential broker serving this one sign-in, on demand, the
 * way every run reads its saved sign-ins, and the broker closes with the leg.
 */
import { modelContractFor } from "@shipbash/contracts/model-contract";
import { writeTaskApiConfig } from "@shipbash/contracts/runtime/job-api.mjs";
import {
  type SignInLegMode,
  type SignInVerifyOutcome,
  signInVerifyOutcomeFrom,
} from "@shipbash/runner/runtime/sign-in-leg.mjs";
import { type TaskBroker, createTaskBroker, signInCheckSource } from "@shipbash/runner/runtime/task-broker.mjs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { redactString } from "../activity-runtime/redaction.ts";
import { authStateVersion, ensureEncryptionKey } from "../init-browser-auth-state.ts";
import {
  readSignInVerifyLog,
  signInVerifyContainerName,
  type SignInVerifyContainerInput,
  startSignInVerifyContainer,
  stopSignInVerifyContainer,
} from "../init-browser-verify.ts";
import { projectAuthDirectoryFor, projectStateDirectoryFor } from "./runtime-glue.ts";
import { shortDigest } from "./short-digest.ts";
import type { SignInBrowserLease } from "./sign-in-takeover-lane.ts";
import {
  SIGN_IN_VERIFY_STRANDED_AFTER_MS,
  SIGN_IN_VERIFY_TIMEOUT_MS,
} from "./sign-in-timing.ts";

const POLL_INTERVAL_MS = 500;

/**
 * The word for a leg that never ran: the host could not start its browser.
 *
 * It is not one of the table's failure words, so the row records `unknown`
 * like any other verdict nobody can name — but the lane says which kind of
 * nothing this was, and the host log carries Docker's own complaint. A
 * password that was never typed has not been proved wrong.
 */
export const SIGN_IN_LEG_NOT_STARTED = "leg_did_not_start";

/** The Docker-facing half, injected so the lane's reasoning is testable without Docker. */
export interface SignInVerifyContainerLane {
  start(input: SignInVerifyContainerInput): Promise<{ name: string }>;
  log(dockerBinary: string, name: string): Promise<string>;
  stop(dockerBinary: string, name: string): Promise<void>;
}

export interface SignInVerifyLaneContext {
  shipbashDirectory: string;
  dockerBinary(): string;
  runnerImage: string;
  projectHash(projectId: string): string;
  ensureImage(dockerBinary: string): Promise<void>;
  containers?: SignInVerifyContainerLane;
  borrowBrowser: (projectId: string, startUrl: string) => Promise<SignInBrowserLease>;
  timeoutMs?: number;
  pollMs?: number;
}

/** The password lane's material: what the leg types, and where it types it. */
export interface SignInLoginCredential {
  email: string;
  password: string;
  totpSecret: string | null;
  /** The product's login page; its Production URL when the Team saved none. */
  loginUrl: string | null;
}

export interface SignInVerifyRequest {
  /** The current browser holds the session just captured by this completion. */
  currentSession?: boolean;
  projectId: string;
  signInId: string;
  productionUrl: string;
  /** The session to prove, sealed under the Project's own browser key. */
  state?: Buffer | undefined;
  /**
   * The credential to sign in with. Exactly one of this and `state`: a
   * session was made by a person, a credential makes one here.
   */
  credential?: SignInLoginCredential | undefined;
}

export interface SignInVerifyResult extends SignInVerifyOutcome {
  /**
   * The session the auto-login leg made, as its host's `promote` keeps it:
   * sealed under the Project's browser key here, the state itself on the
   * hosted console. Absent for a leg that was handed one, which has nothing
   * new to save.
   */
  state?: Buffer | undefined;
  /** `authv_…`, the name the host gives those exact bytes. */
  stateVersion?: string | undefined;
}

export interface SignInVerifyLane {
  /** Runs one check to its end and answers what the leg said. Never throws. */
  verify(request: SignInVerifyRequest): Promise<SignInVerifyResult>;
  /** The leg's screencast while it runs, so the page can show the check. */
  streamUrl(signInId: string): string | null;
}

const DEFAULT_CONTAINERS: SignInVerifyContainerLane = {
  start: startSignInVerifyContainer,
  log: readSignInVerifyLog,
  stop: stopSignInVerifyContainer,
};

interface VerifyExchange {
  /** The sign-in's own directory, which outlives every attempt inside it. */
  parent: string;
  /** This attempt's directory, mounted once and never again. */
  root: string;
  /** What every attempt on this sign-in is named after. */
  key: string;
}

/**
 * Where one attempt's exchange lives.
 *
 * Every attempt gets a directory of its own, because Docker's file-sharing
 * layer remembers the paths it has resolved: a path it has resolved and then
 * seen deleted is refused as "bind source path does not exist" when a
 * directory of the same name is recreated, and the refusal lands in
 * milliseconds, before any browser runs. A fixed name per sign-in therefore
 * gives each row exactly one real check per host lifetime, and every later
 * one a verdict it never earned. So the name is used once, and teardown takes
 * away the attempt's own subtree while the parent stays put.
 */
function verifyExchangeFor(
  shipbashDirectory: string,
  projectId: string,
  signInId: string,
): VerifyExchange {
  const key = shortDigest(signInId);
  const parent = join(projectStateDirectoryFor(shipbashDirectory, projectId), "sign-in-verify");
  return { parent, root: join(parent, `${key}-${randomBytes(6).toString("hex")}`), key };
}

/** The page a password leg signs in on: the saved login page, or the product itself. */
function signInPageUrl(request: SignInVerifyRequest): string {
  return request.credential?.loginUrl ?? request.productionUrl;
}

/**
 * What the leg is given, as the one-shot config it reads once. A session is
 * base64 of the sealed bytes, which is why it travels on a 0600 file inside a
 * read-only mount and never on argv. A password leg's config names only the
 * pages; its credential stays behind the broker.
 */
function legConfig(request: SignInVerifyRequest, encryptionKey: string, browser: SignInBrowserLease): Record<string, unknown> {
  const shared = { productionUrl: request.productionUrl, encryptionKey, browserCdpUrl: browser.cdpUrl };
  if (request.credential) {
    return { ...shared, modelContract: modelContractFor("sign_in"), signInPageUrl: signInPageUrl(request) };
  }
  return { ...shared, useCurrentSession: request.currentSession === true && browser.reused, state: (request.state ?? Buffer.alloc(0)).toString("base64") };
}

/**
 * What earlier attempts on this sign-in left behind, when a crash took the
 * leg before its own teardown ran. Each of those names was used once and is
 * never mounted again, so removing them frees the disk without taking away a
 * path Docker could still be asked for.
 *
 * Age is what separates a leftover from a sibling. Two checks of one row can
 * be in the air at once, and sweeping by name alone took the live one's
 * session file and consumed marker out from under it, so the leg already
 * running ended `unknown` on a session it never got to try. Only a directory
 * older than any leg could still be is nobody's.
 */
async function clearEarlierAttempts(exchange: VerifyExchange): Promise<void> {
  const entries: string[] = await readdir(exchange.parent).catch(() => []);
  const abandonedBefore = Date.now() - SIGN_IN_VERIFY_STRANDED_AFTER_MS;
  await Promise.all(entries
    .filter((entry) => entry.startsWith(`${exchange.key}-`) && join(exchange.parent, entry) !== exchange.root)
    .map(async (entry) => {
      const path = join(exchange.parent, entry);
      const attempt = await stat(path).catch(() => null);
      if (!attempt || attempt.mtimeMs >= abandonedBefore) return;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }));
}

/** The three directories one leg uses, with what it was given already inside. */
async function prepareVerifyDirectories(input: {
  exchange: VerifyExchange;
  config: Record<string, unknown>;
}): Promise<{ controlDirectory: string; sessionDirectory: string; configPath: string }> {
  const controlDirectory = join(input.exchange.root, "control");
  const sessionDirectory = join(input.exchange.root, "session");
  await mkdir(input.exchange.parent, { recursive: true, mode: 0o700 });
  await clearEarlierAttempts(input.exchange);
  await Promise.all([
    mkdir(join(controlDirectory, "auth"), { recursive: true, mode: 0o700 }),
    mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const configPath = join(sessionDirectory, "config.json");
  await writeFile(configPath, `${JSON.stringify(input.config)}\n`, { mode: 0o600 });
  return { controlDirectory, sessionDirectory, configPath };
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

/**
 * The password leg's broker, told to the container on its control mount. It
 * serves the one sign-in under check and dies with the leg: closed when the
 * leg ends, and at the leg's deadline if nothing closed it sooner.
 */
async function openLoginBroker(
  request: SignInVerifyRequest,
  controlDirectory: string,
  timeoutMs: number,
): Promise<TaskBroker | null> {
  if (!request.credential) return null;
  const check = signInCheckSource({
    signInId: request.signInId,
    signInPageUrl: signInPageUrl(request),
    credential: request.credential,
  });
  const broker = await createTaskBroker({
    source: check,
    host: "host.docker.internal",
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    await writeTaskApiConfig(controlDirectory, { ...broker.config, signIns: check.signIns });
  } catch (error) {
    broker.close();
    throw error;
  }
  return broker;
}

async function releaseBorrowedBrowser(browser: SignInBrowserLease | null) {
  await browser?.release().catch(() => undefined);
}

export function createSignInVerifyLane(context: SignInVerifyLaneContext): SignInVerifyLane {
  const containers = context.containers ?? DEFAULT_CONTAINERS;
  const timeoutMs = context.timeoutMs ?? SIGN_IN_VERIFY_TIMEOUT_MS;
  const pollMs = context.pollMs ?? POLL_INTERVAL_MS;
  const streams = new Map<string, string>();

  /**
   * Watches one running leg: releases the session file the moment the
   * container says it has it, publishes the stream the page watches, and
   * answers with the outcome the log carries, or nothing when time runs out.
   */
  async function watch(input: {
    dockerBinary: string;
    name: string;
    signInId: string;
    configPath: string;
    consumedPath: string;
  }): Promise<SignInVerifyOutcome | null> {
    const deadline = Date.now() + timeoutMs;
    let released = false;
    while (Date.now() < deadline) {
      if (!released && (await exists(input.consumedPath))) {
        await rm(input.configPath, { force: true });
        released = true;
      }
      const outcome = signInVerifyOutcomeFrom(await containers.log(input.dockerBinary, input.name));
      if (outcome) return outcome;
      await delay(pollMs);
    }
    return null;
  }

  return {
    streamUrl: (signInId) => streams.get(signInId) ?? null,
    verify: async (request) => {
      const dockerBinary = context.dockerBinary();
      const mode: SignInLegMode = request.credential ? "sign-in-login" : "sign-in-verify";
      const exchange = verifyExchangeFor(context.shipbashDirectory, request.projectId, request.signInId);
      const authDirectory = projectAuthDirectoryFor(context.shipbashDirectory, request.projectId);
      let name = signInVerifyContainerName(request.signInId);
      let browser: SignInBrowserLease | null = null;
      let broker: TaskBroker | null = null;
      try {
        browser = await context.borrowBrowser(request.projectId, signInPageUrl(request));
        streams.set(request.signInId, browser.streamUrl);
        await mkdir(authDirectory, { recursive: true, mode: 0o700 });
        const directories = await prepareVerifyDirectories({
          exchange,
          config: legConfig(request, await ensureEncryptionKey(authDirectory), browser),
        });
        await context.ensureImage(dockerBinary);
        broker = await openLoginBroker(request, directories.controlDirectory, timeoutMs);
        const started = await containers.start({
          dockerBinary,
          image: context.runnerImage,
          mode,
          browserContainerId: browser.containerId,
          signInId: request.signInId,
          projectHash: context.projectHash(request.projectId),
          controlDirectory: directories.controlDirectory,
          sessionDirectory: directories.sessionDirectory,
        }).catch((error: unknown) => {
          // A browser that never opened has proved nothing either way, so the
          // host's own trouble is said in the host's own word rather than
          // dressed up as a verdict on what the leg was going to try.
          console.error(
            `[sign-ins] the check for ${request.signInId} could not start its browser:`,
            redactString(error instanceof Error ? error.message : String(error)),
          );
          return null;
        });
        if (!started) return { verified: false, label: null, reason: SIGN_IN_LEG_NOT_STARTED };
        name = started.name;
        const outcome = await watch({
          dockerBinary,
          name,
          signInId: request.signInId,
          configPath: directories.configPath,
          consumedPath: join(directories.controlDirectory, "sign-in-verify-consumed"),
        });
        // Silence is not a pass. A leg that never spoke leaves the sign-in
        // exactly where a failed one does, with the word for "we do not know".
        if (!outcome) return { verified: false, label: null, reason: "unknown" };
        if (mode !== "sign-in-login" || !outcome.verified) return outcome;
        // The auto-login leg made the session, so it is read back before the
        // exchange directory goes. A leg that says it got in and leaves no
        // session has proved nothing this Project can keep.
        const state = await readFile(join(directories.controlDirectory, "sign-in-login.json.enc"))
          .catch(() => null);
        if (state === null || state.length === 0) {
          return { verified: false, label: null, reason: "unknown" };
        }
        return { ...outcome, state, stateVersion: authStateVersion(state) };
      } catch (error) {
        console.error(
          `[sign-ins] the check for ${request.signInId} failed:`,
          redactString(error instanceof Error ? error.message : String(error)),
        );
        return { verified: false, label: null, reason: "unknown" };
      } finally {
        streams.delete(request.signInId);
        broker?.close();
        await containers.stop(dockerBinary, name).catch(() => undefined);
        await releaseBorrowedBrowser(browser);
        // Only this attempt's own subtree: the parent it sits in is what the
        // next check of this sign-in needs to still be there.
        await rm(exchange.root, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
