import { TERMINAL_ACTIVITY_STATUS_VALUES } from "@shipbash/contracts/activity-lifecycle";
import type { Route } from "next";

import type { ActivityDetail } from "../../lib/web-client";
import type { RetainedTerminalLog } from "../_components/activity-terminal";
import type { AgentPointerSignal } from "../_components/agent-cursor";
import { route } from "./route";

/**
 * Pure readings of an Activity's persisted event feed. The page derives its
 * live surfaces (stream, mirror, pointer, wrap-up state) from these instead of
 * scanning the events inline.
 */

type ActivityEvents = ActivityDetail["events"];

/** What a walk leaves to keep or discard, as the service reviews it. */
export type ActivityReview = NonNullable<ActivityDetail["review"]>;

/** The walk's review when it is an edit walk, the page's Edit-run variant; else null. */
export function editWalkReview(activity: ActivityDetail | undefined): ActivityReview | null {
  return activity?.review?.kind === "journey_edit" ? activity.review : null;
}

/** Statuses after which no further event can arrive. */
export const terminalActivities = new Set<string>(TERMINAL_ACTIVITY_STATUS_VALUES);

/** The first Activity that ended needing the reader, if any: the Overview reads it in full. */
export function stoppedActivityId(activities: readonly Pick<ActivityDetail, "id" | "status">[]): string | null {
  return activities.find((activity) => activity.status === "needs_attention")?.id ?? null;
}

export function proposalsReviewHref(
  proposals: readonly { id: string }[],
  teamHref: (pathname: string) => Route,
): Route | null {
  const [first] = proposals;
  if (proposals.length === 1 && first) return teamHref(`/proposals/${encodeURIComponent(first.id)}`);
  return proposals.length > 1 ? teamHref("/proposals") : null;
}

/**
 * How often an Activity is read again, the one rule every observer of it reads
 * on. While it runs: every second, or every 15 s while its event stream is
 * open and carries the rest (the stream's 270 s reconnect lets one full read
 * through, which is the reconciliation, not a fault). Once it has ended: never.
 * Only the page holds the stream: an observer beside it passes the page's
 * `streamLive`, one on a page of its own passes false.
 */
export function activityPollInterval(
  activity: Pick<ActivityDetail, "status"> | undefined,
  streamLive: boolean,
): number | false {
  if (activity && !terminalActivities.has(activity.status)) return streamLive ? 15_000 : 1_000;
  return false;
}

export function cancelableActivity(status: ActivityDetail["status"]): boolean {
  return status === "debouncing"
    || status === "queued"
    || status === "running"
    || status === "waiting_for_auth"
    // A run blocked on a question is still a run the reader can stop.
    || status === "waiting_for_input";
}

/** The settings deep-link that resolves a Cloudflare block: the product's own pane of the hub. */
export function trustedAccessHrefFor(
  teamHref: (pathname: string) => Route,
  activityId: string,
): Route {
  // The pane's address names the product, so the scope this href is built in
  // is what picks it out — there is no slug left to spell in the path.
  const base = teamHref("/settings/project");
  const separator = base.includes("?") ? "&" : "?";
  return route(`${base}${separator}trustedAccess=cloudflare&activity=${encodeURIComponent(activityId)}`);
}

export function activityHasAgentMessages(events: ActivityEvents): boolean {
  return events.some((event) => (
    (event.safeData.event === "agent_narrative" || event.safeData.event === "agent_output")
    && event.bodyMarkdown?.trim()
  ));
}

/**
 * The events of the leg now running. A resumed run keeps every earlier leg's
 * events in its stream, and a teardown or sign-in request from one of those
 * must never describe the leg that is live now.
 */
function currentLegEvents(events: ActivityEvents): ActivityEvents {
  const lastStartIndex = events.reduce((latest, event, index) => (
    event.kind === "lifecycle" && event.label === "Activity started" ? index : latest
  ), -1);
  return events.slice(lastStartIndex + 1);
}

// The agent stops talking well before the run is terminal: the runner still
// has to save the recording, upload the screenshot, and write the result.
// The agent session's finish and the teardown evidence events mark that
// window so the UI can say "finalizing" instead of freezing on "Running" —
// the session finish first, because the evidence lands only as the host
// disposes the container, moments before the status turns over.
// Only markers from the CURRENT leg count: a resumed run keeps the previous
// leg's teardown events in its stream, and matching those made every
// post-takeover leg render as finalizing with its live stream cut.
// Waiting for the user's sign-in and the queued hand-back window are never
// "finalizing" either.
export function activityFinalizing(
  activity: Pick<ActivityDetail, "events" | "status">,
  activityTerminal: boolean,
): boolean {
  return !activityTerminal
    && activity.status !== "waiting_for_auth"
    && activity.status !== "queued"
    // The session also finishes when the agent parks for a sign-in; that
    // tail is the sign-in's wait (activityAuthPending), not a finalization.
    && !activityAuthPending(activity)
    && currentLegEvents(activity.events).some((event) =>
      // A session that finished by cancel or timeout is not "publishing the
      // result" — those turn the run terminal, not finalizing.
      (event.kind === "lifecycle" && event.safeData.event === "agent_session_finished"
        && event.safeData.canceled !== true && event.safeData.timedOut !== true)
      || (event.kind === "evidence"
        && /browser recording ready|browser recording retained|final browser screenshot/iu.test(event.label ?? "")));
}

// The agent files its sign-in request, closes its turn, and the runtime is
// released before the status turns to waiting_for_auth. Across that whole
// running tail the sign-in is what the run waits on, so the status line names
// it ("wrapping up this pass…") and outranks the finalizing hint — otherwise
// the tail after the session finishes would read "Exploration complete" while
// the run is really parking for a login. (The ~1.5s window when a leg resumed
// after a completed sign-in has been claimed as running but has not yet
// emitted its own "Activity started" still carries the previous leg's request
// in this slice and briefly reads the same way; distinguishing it needs a host
// resume-boundary event.)
export function activityAuthPending(activity: Pick<ActivityDetail, "events" | "status">): boolean {
  return activity.status === "running"
    && currentLegEvents(activity.events).some((event) =>
      event.kind === "lifecycle" && event.safeData.event === "human_auth_requested");
}

export function latestActivityEventSequence(events: ActivityEvents): number {
  return events.reduce(
    (latest, event) => Math.max(latest, event.sequence),
    0,
  );
}

export function activityBrowserPage(events: ActivityEvents, fallbackAddress: string | null): {
  address: string;
  title: string | null;
  faviconUrl: string | null;
} {
  const browserPageMetadata = [...events].reverse().find((event) => (
    event.safeData.event === "browser_page_metadata"
  ));
  return {
    address: typeof browserPageMetadata?.safeData.pageUrl === "string"
      ? browserPageMetadata.safeData.pageUrl
      : fallbackAddress ?? "",
    title: typeof browserPageMetadata?.safeData.pageTitle === "string"
      ? browserPageMetadata.safeData.pageTitle
      : null,
    faviconUrl: typeof browserPageMetadata?.safeData.faviconDataUrl === "string"
      ? browserPageMetadata.safeData.faviconDataUrl
      : null,
  };
}

// The chat's live pulse: even between the agent's narrated updates, the
// event flow proves work is happening — surface it instead of dead air.
// Counts the browser-class agent_action completions the tool rows are built
// from, so the count and the rows can never disagree.
export function completedBrowserActionCount(events: ActivityEvents): number {
  return events.filter((event) =>
    event.safeData.event === "agent_action" && event.safeData.toolClass === "browser").length;
}

/**
 * The terminal session logs the run retained, addressed by the API route that
 * serves them. The session ids ride their own detail field, derived by the
 * server from the FULL event list — the wire's 300-event tail would silently
 * drop a log recorded early in a long run.
 */
export function retainedTerminalLogs(
  sessionIds: readonly string[],
  projectId: string,
  activityId: string,
): readonly RetainedTerminalLog[] {
  return [...new Set(sessionIds)].map((sessionId) => ({
    sessionId,
    url: `/api/projects/${encodeURIComponent(projectId)}/activities/${encodeURIComponent(activityId)}/terminal-logs/${encodeURIComponent(sessionId)}`,
    // A discovery records no terminal track; each log's own header orders it.
    order: null,
  }));
}

/**
 * The surface the agent is actually working on right now, read from its most
 * recent browser/terminal action. Knowledge, auth, and read actions do not
 * move the needle — the agent has not left the surface it last drove.
 */
export function latestAgentSurface(events: ActivityEvents): "browser" | "terminal" {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.safeData.event !== "agent_action") continue;
    const toolClass = event.safeData.toolClass;
    if (toolClass === "terminal") return "terminal";
    if (toolClass === "browser") return "browser";
  }
  return "browser";
}

export function latestAgentPointer(events: ActivityEvents): AgentPointerSignal | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.safeData.event !== "agent_pointer") continue;
    const { action, x, y } = event.safeData;
    if (typeof x !== "number" || typeof y !== "number") continue;
    return {
      id: event.id,
      action: typeof action === "string" ? action : "click",
      x,
      y,
    };
  }
  return null;
}
