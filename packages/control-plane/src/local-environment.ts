export const REMOTE_RUNNER_CREDENTIAL_KEYS = [
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

export function withoutRemoteRunnerCredentials(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...base };
  for (const key of REMOTE_RUNNER_CREDENTIAL_KEYS) delete sanitized[key];
  return sanitized;
}
