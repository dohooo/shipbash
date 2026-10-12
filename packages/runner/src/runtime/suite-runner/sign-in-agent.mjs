/**
 * The Settings agent reads the saved sign-in it is checking through the same
 * credential broker and get_credentials interface as verification and
 * discovery: the host serves this one sign-in, field by field, on demand.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CAPABILITIES } from "@shipbash/contracts/runtime/capabilities.mjs";
import { credentialInstructions } from "@shipbash/contracts/runtime/credential-contract.mjs";
import { availableSignIns, startCredentialControl } from "../credentials-control.mjs";
import { AGENT_ABORT_TIMEOUT, createAgentBudget, runPiAgent, sourceTools } from "../pi-agent.mjs";
import { BROWSER_SOURCE, openRunnerTools } from "../tools.mjs";
import { registerCredentialValues } from "./redaction.mjs";
import { AGENT_BROWSER_MCP_ENV_VARS, RUNTIME_DIRECTORY, WORK_DIRECTORY } from "./environment.mjs";

// A specialist, not a scenario: its fixed list is the browser and the saved
// sign-in it checks, whatever the capability table gives the scenarios.
const SIGN_IN_ROWS = Object.freeze(["browser", "credentials"]);

// The label names the way in on its card and is what a second save of the
// same account is matched on (foldDuplicateTeamSignIn), so it is the account
// itself: one token, no longer than team_sign_ins.label holds. pi validates the
// deliver call against this, so a sentence goes back to the agent to fill again.
export const SIGN_IN_SCHEMA = { type: "object", additionalProperties: false,
  required: ["verified", "reason", "label"], properties: { verified: { type: "boolean" },
    reason: { type: ["string", "null"], enum: [null, "wrong_credentials", "second_factor_required", "captcha_required", "login_page_not_found", "session_expired", "sso_enforced", "new_device_verification", "unknown"] },
    label: {
      type: ["string", "null"], pattern: "^\\S+$", maxLength: 200,
      description: "The signed-in account exactly as the product shows it: an email address, username or handle, such as ada@example.com or @ada, as one token with no spaces. null when the product shows no account. Never a sentence about the check.",
    } } };

export async function runSignInAgent(config, env) {
  // This lane keeps no shell log, and its events carry no value it was served.
  const control = await startCredentialControl({ registerSecrets: registerCredentialValues, onUnmasked: () => undefined });
  if (!control) throw new Error("The sign-in check was given no credential service.");
  const signIns = availableSignIns();
  const resultPath = join(WORK_DIRECTORY, "sign-in-result.json");
  const budget = createAgentBudget({ timeoutMs: 150_000 });
  let tooling = null;
  try {
    tooling = await openRunnerTools({ rows: SIGN_IN_ROWS, tools: SIGN_IN_ROWS.flatMap((row) => CAPABILITIES[row].tools) }, env, {
      runtimeDirectory: RUNTIME_DIRECTORY, browserEnv: AGENT_BROWSER_MCP_ENV_VARS, credentials: control,
      wrap: (name, source, listed) => sourceTools(source, listed, name === BROWSER_SOURCE ? 60_000 : 25_000),
    });
    const run = await runPiAgent({
      modelContract: config.modelContract,
      systemInstructions: `${credentialInstructions(signIns)} You are checking a saved sign-in, not testing business actions. The project browser is already open: first inspect its current page and continue there. Do not reload or reopen a login page that is already usable. Navigate the existing tab to the supplied login URL only if needed. Sign in with the supplied account, then confirm authenticated access to the product. A pre-existing signed-in session does not prove the supplied credentials: sign out through the product first if necessary. Report verified only with actual signed-in page evidence. Do not modify account security or product data.`,
      prompt: `Login URL: ${config.signInPageUrl}\nProduct: ${config.productionUrl}`,
      schema: SIGN_IN_SCHEMA,
      resultPath,
      cwd: WORK_DIRECTORY,
      customTools: tooling.tools,
      signal: budget.signal,
      scratchDirectory: WORK_DIRECTORY,
    });
    if (!run.delivered) {
      throw new Error(run.failure ?? (run.aborted === AGENT_ABORT_TIMEOUT ? "The sign-in agent ran out of time." : "The sign-in agent could not finish."));
    }
    const answer = JSON.parse(await readFile(resultPath, "utf8"));
    return { verified: answer.verified === true, reason: answer.reason ?? null, label: typeof answer.label === "string" ? answer.label : null };
  } finally {
    budget.dispose();
    await Promise.allSettled([tooling?.close(), control?.close()]);
  }
}
