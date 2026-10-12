import { credentialError } from "@shipbash/contracts/runtime/credential-contract.mjs";
import { TOTP_STEP_SECONDS, totpCode, totpStep } from "./totp.mjs";
/** The seed stays in the service; only explicitly requested fields leave it. */
export function credentialValues(fields, material, now = Date.now()) {
  const result = {};
  if (fields.includes("username") && material.username) result.username = material.username;
  if (fields.includes("password") && material.password) result.password = material.password;
  if (fields.includes("totp") && material.totpSecret) result.totp = {
    code: totpCode(material.totpSecret, { nowMs: now }), expiresAt: new Date((totpStep(now) + 1) * TOTP_STEP_SECONDS * 1_000).toISOString(),
  };
  const missingFields = fields.filter(field => !Object.hasOwn(result, field));
  return missingFields.length ? credentialError("credential_unavailable", { missingFields }) : result;
}
