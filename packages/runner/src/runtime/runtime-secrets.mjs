/**
 * The secrets a runner holds that its sandbox shell can print. The shell
 * inherits the runner's environment and runs as the runner's user, so the
 * keys in that environment and the product sign-in the runner restores are
 * each one command away from its output. Registering them with the runner's
 * redactor masks them wherever they appear: in the terminal's recording and
 * in every event. They are registered again whenever they may have changed —
 * a walk or leg starting, a sign-in the runner captures.
 */
import { AGENT_SERVICE_VARIABLES } from "@shipbash/contracts/runtime/agent-model.mjs";

import { readBrowserStateFile } from "./browser-state-seal.mjs";
import { availableSignIns } from "./credentials-control.mjs";
import { githubAccountLogin } from "./github-account-identity.mjs";

const ENVIRONMENT_SECRETS = [
  AGENT_SERVICE_VARIABLES.modelApiKey, AGENT_SERVICE_VARIABLES.jevApiKey, "SHIPBASH_HUMAN_AUTH_PASSWORD", "AGENT_BROWSER_ENCRYPTION_KEY",
];
/**
 * A session identifier carries at least 64 bits of entropy (OWASP Session
 * Management), 16 hex characters. A shorter cookie value is a preference,
 * and masking it would mask ordinary words.
 */
const MIN_COOKIE_SECRET_LENGTH = 16;

/**
 * The session cookies of a product sign-in. A cookie holding an account's name
 * is not one: GitHub's `dotcom_user` holds the login (github-account-identity.mjs),
 * and a product may keep a bound sign-in's account in a cookie of its own. The
 * host keeps those accounts in clear, the agent is told them
 * (credential-contract.mjs) and writes them into the steps that name them.
 * Masked, an account would also leave the transcript's stored system prompt
 * differing from the one pi sends, and pi would send it again every turn.
 * @param {{ cookies: Array<{ name: string, value: string, domain: string, httpOnly: boolean }> }} state
 */
export function signInStateSecrets(state) {
  const accounts = new Set([githubAccountLogin(state.cookies), ...availableSignIns().map((signIn) => signIn.account)]
    .filter((account) => typeof account === "string")
    .map((account) => account.toLowerCase()));
  return state.cookies.map((cookie) => cookie.value)
    .filter((value) => value.length >= MIN_COOKIE_SECRET_LENGTH && !accounts.has(value.toLowerCase()));
}

/** The session cookies of the product sign-in the runner restores. */
async function savedSignInSecrets(statePath, encryptionKey) {
  if (!statePath) return [];
  try {
    return signInStateSecrets(await readBrowserStateFile(statePath, encryptionKey));
  } catch {
    return [];
  }
}

/**
 * @param {(value: unknown) => void} registerSecret the runner's redactor's
 * @param {{ statePath: string | null, env?: Record<string, string | undefined> }} scope
 */
export async function registerRuntimeSecrets(registerSecret, { statePath, env = process.env }) {
  const secrets = [
    ...ENVIRONMENT_SECRETS.map((name) => env[name]),
    ...await savedSignInSecrets(statePath, env.AGENT_BROWSER_ENCRYPTION_KEY),
  ];
  for (const secret of secrets) registerSecret(secret);
}
