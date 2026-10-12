/** The credential service returns values; the agent owns all website interaction. */
export const CREDENTIAL_FIELDS = Object.freeze(["username", "password", "totp"]);
export const CREDENTIAL_ERRORS = Object.freeze({
  invalid_request: "Provide a sign-in ID and one or more fields: username, password, or totp.",
  access_denied: "This task cannot access that sign-in. Use an account bound to the current project.",
  binding_revoked: "This sign-in has been revoked. Ask the owner to restore access in Settings → Sign-in.",
  credential_unavailable: "The requested credential is not configured. Ask the owner to update this account in Settings → Sign-in.",
  task_inactive: "This task is no longer active. Credentials are available only to an active authorized task.",
  service_unavailable: "Stored credentials could not be read. Retry once; if this persists, ask the owner to check Settings → Sign-in.",
});
export function credentialError(error, extra = {}) {
  return { error, message: CREDENTIAL_ERRORS[error] ?? CREDENTIAL_ERRORS.service_unavailable, ...extra };
}
export function validCredentialRequest(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => key === "signInId" || key === "fields")
    && typeof value.signInId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.signInId)
    && Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 3
    && new Set(value.fields).size === value.fields.length
    && value.fields.every(field => CREDENTIAL_FIELDS.includes(field));
}
export function credentialToolDefinition(signIns = []) {
  return {
    name: "get_credentials",
    description: `Read only the requested credentials of an authorized project sign-in. You operate the browser yourself: check the intended site and account, locate fields, fill, submit, and assess the result. TOTP includes expiresAt; request a fresh code if expired. Never disclose credentials in narration, reports, knowledge, URLs or files. A successful read does not mean login succeeded. Available accounts: ${JSON.stringify(signIns)}`,
    inputSchema: { type: "object", additionalProperties: false, required: ["signInId", "fields"], properties: {
      signInId: { type: "string", description: "ID from the available accounts." },
      fields: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string", enum: [...CREDENTIAL_FIELDS] } },
    } },
  };
}
/**
 * How to use get_credentials: the credentials row's prompt text
 * (capabilities.mjs). The accounts it serves are listed in the tool's own
 * description.
 */
export const CREDENTIAL_GUIDANCE =
  "Use get_credentials with signInId and fields (username, password, totp) when needed. You own the login flow: choose the authorized account, check its allowedOrigins, locate and fill inputs with browser tools, submit, and observe the result. Use saved browser sessions first when they work. Do not request a TOTP for SMS, email, a passkey, or CAPTCHA. Never enroll or reset MFA. Do not repeat a rejected code in the same time window; inspect the error and request a fresh code if appropriate. Stop after two rejected authentication attempts and report an authorization block with the account and what the owner needs to fix. Do not disclose secrets in narration, reports or knowledge. Credential retrieval is not evidence of successful authentication.";
/** The sign-in check's line: the accounts it may use, then the guidance. */
export function credentialInstructions(signIns) {
  return `Saved sign-ins available to this task: ${JSON.stringify(signIns)}. ${CREDENTIAL_GUIDANCE}`;
}
