/**
 * Console addresses the product hands out of the console — in a Slack alert,
 * in a conversation's answer — built in one place. Every console address
 * carries the team and project.
 */

/** Where the links point. */
export interface ConsoleLinks {
  /** The console's origin, as `configuredPublicUrl` resolves it. */
  publicOrigin: string;
  teamSlug: string;
  projectSlug: string;
}

/** A page of the project in the console, by its path under the project. */
export function scopedUrl(links: ConsoleLinks, path: string): string {
  const origin = links.publicOrigin.replace(/\/+$/u, "");
  return `${origin}/${encodeURIComponent(links.teamSlug)}/${encodeURIComponent(links.projectSlug)}/${path}`;
}

/** An Activity's page — a walk's, a conversation's: the console shows there what a chat does not. */
export function activityUrl(links: ConsoleLinks, activityId: string): string {
  return scopedUrl(links, `activities/${encodeURIComponent(activityId)}`);
}

/** A proposal's review page: the Journeys a walk drafted, kept or discarded there. */
export function proposalUrl(links: ConsoleLinks, proposalId: string): string {
  return scopedUrl(links, `proposals/${encodeURIComponent(proposalId)}`);
}

export function runUrl(links: ConsoleLinks, runId: string): string {
  return scopedUrl(links, `verifications/${encodeURIComponent(runId)}`);
}

/**
 * One journey inside the run's page: the run page selects the walk a
 * `?journey=<Case Run id>` names, and an earlier attempt's id opens that
 * attempt.
 */
export function journeyUrl(links: ConsoleLinks, runId: string, caseRunId: string): string {
  return `${runUrl(links, runId)}?journey=${encodeURIComponent(caseRunId)}`;
}

/**
 * The Case Run a Journey run's page link names (journeyUrl), or the id
 * itself when that is what was given; "" for a link that names none.
 */
export function journeyRunOf(linkOrId: string): string {
  const value = linkOrId.trim();
  if (!URL.canParse(value)) return value;
  return new URL(value).searchParams.get("journey") ?? "";
}
