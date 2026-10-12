// get_credentials: a saved sign-in's fields, read through the run's
// credential control (credentials-control.mjs), which asks the task API and
// registers every value for masking before it answers.
import { credentialToolDefinition, credentialError, validCredentialRequest } from "@shipbash/contracts/runtime/credential-contract.mjs";

export const CREDENTIALS_TOOL = "get_credentials";
/** The longest a read may take before the agent is told to retry. */
const TIMEOUT_MS = 20_000;

/**
 * The control's answer, or the service error once the read has taken
 * TIMEOUT_MS. Values are returned to the agent; seed material never crosses
 * this bridge.
 * @param {{ read: (request: { signInId: string, fields: string[] }) => Promise<Record<string, unknown>> } | null} control
 * @param {{ signInId: string, fields: string[] }} request
 */
async function readWithin(control, request) {
  if (!control) return credentialError("service_unavailable");
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(credentialError("service_unavailable")), TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([control.read(request).catch(() => credentialError("service_unavailable")), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The tool for the sign-ins on offer: its definition, which lists them, and
 * its call, which answers the values as JSON or fails with the credential
 * error, as JSON, that the agent can act on.
 * @param {Parameters<typeof readWithin>[0]} control the run's credential control
 * @param {unknown[]} signIns
 */
export function credentialsTool(control, signIns) {
  return {
    definitions: [credentialToolDefinition(signIns)],
    /** @param {string} _name @param {Record<string, unknown>} args */
    async call(_name, args) {
      const result = validCredentialRequest(args) ? await readWithin(control, args) : credentialError("invalid_request");
      const text = JSON.stringify(result);
      if (result.error) throw new Error(text);
      return text;
    },
  };
}
