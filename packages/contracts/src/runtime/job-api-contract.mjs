/**
 * The job API's names, free of Node built-ins so any module may read them
 * (the Sandbox network policy): where a Sandbox asks, and where its firewall
 * forwards the call. The client and the wire format are job-api.mjs.
 */

/**
 * The name a Sandbox asks the job API at, which the deployment configures: a
 * public DNS name of its own on a TEST-NET address, so no journey opens it
 * and only a Sandbox's forward rule answers it.
 */
export const JOB_API_HOST_VARIABLE = "SHIPBASH_JOB_API_HOST";

/** The configured job API name, refused unless it is a bare host name. */
export function jobApiHost(environment) {
  const value = environment[JOB_API_HOST_VARIABLE]?.trim();
  if (!value) throw new Error(`${JOB_API_HOST_VARIABLE} must be configured.`);
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(value)) {
    throw new Error(`${JOB_API_HOST_VARIABLE} must be a lower-case DNS name, such as job-api.example.com.`);
  }
  return value;
}

/** Where a Sandbox's job API calls go: the configured name, over HTTPS. */
export function jobApiOrigin(environment) {
  return `https://${jobApiHost(environment)}`;
}

/**
 * Where a Sandbox's forward rule sends the job's calls, and so the audience
 * of the identity the firewall signs for it: the Sandbox's policy names it,
 * and the server rebuilds it to check that audience.
 * @param {string} origin
 * @param {string} jobId
 */
export function jobApiForwardUrl(origin, jobId) {
  return `${origin}/api/jobs/${encodeURIComponent(jobId)}`;
}
