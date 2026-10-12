"use client";

/**
 * Slack going quiet, as something that needs the reader.
 *
 * The whole alerting feature exists so a failure at 02:00 is heard, and its
 * own failure mode is silence: the app is removed from the workspace, an
 * install is never finished, a channel stops taking messages — and ShipBash
 * goes on believing it is announcing things. A dead connection shown only in
 * Settings is a dead connection nobody finds, so each silence is stated on the
 * Overview of every project it silences, as an ordinary item of the shipped
 * attention list.
 *
 * There is one description of a silence here and three renderings of it — the
 * Overview item, the routing row's delivery cell, and Project › Alerts —
 * because a reader who met one of them yesterday should not have to translate
 * the other. The count beside it is a count of outbox rows, never a re-reading
 * of the runs, and it is carried on the connection the console already fetches.
 */
import { useQuery } from "@tanstack/react-query";
import type { Route } from "next";

import {
  readQuery,
  type SlackChannel,
  type SlackChannelBinding,
  type SlackDeliveryError,
  type SlackWorkspace,
  type webClient,
} from "../../lib/web-client";
import type { AttentionItem } from "../_lib/journeys";
import { relativeTimeLabel } from "./relative-time";

export type SlackConnections = Awaited<ReturnType<typeof webClient.slackConnections>>;

/**
 * What each refused delivery means, and the one thing that fixes it. Amber
 * rather than red throughout: nothing is broken yet, but the next failure goes
 * unannounced unless a human acts.
 *
 * `fix` is the instruction alone, so the row's test button can say what the
 * occasion was ("Test failed — …") while the Overview, which ran no test, says
 * only what to do.
 */
const DELIVERY_FAULTS: Record<SlackDeliveryError, { reads: string; fix: string }> = {
  not_in_channel: {
    reads: "ShipBash not in channel",
    fix: "run /invite @ShipBash in the channel, then retry",
  },
  channel_not_found: {
    reads: "Channel not found",
    fix: "that channel is gone; pick another, then retry",
  },
  is_archived: {
    reads: "Channel archived",
    fix: "that channel is archived; pick another, then retry",
  },
  delivery_failed: {
    reads: "Slack refused the message",
    fix: "retry, and pick another channel if it keeps failing",
  },
};

/** What a refused delivery reads as, and what fixes it, wherever it is shown. */
export function deliveryFault(error: SlackDeliveryError): { reads: string; fix: string } {
  return DELIVERY_FAULTS[error];
}

/**
 * Why Slack would not let a channel be chosen, one sentence each. Slack
 * refuses before anything is posted, so these are about the channel and never
 * about a message.
 */
const SAVE_REFUSALS: Record<SlackDeliveryError, string> = {
  not_in_channel: "Not saved: ShipBash is not in that channel. Run /invite @ShipBash in it, then choose it again.",
  channel_not_found: "Not saved: that channel no longer exists. Choose another.",
  is_archived: "Not saved: that channel is archived. Choose another.",
  delivery_failed: "Not saved: Slack would not let ShipBash use that channel. Try again, or choose another.",
};

/** What the routing row says when Slack refused the channel it was given. */
export function saveRefusal(error: SlackDeliveryError): string {
  return SAVE_REFUSALS[error];
}

/** The one place a channel is spelled, so the card, the item and the tooltips agree. */
export function channelLabel(channel: SlackChannel): string {
  return channel.isPrivate ? `${channel.name} (private)` : `#${channel.name}`;
}

/** The one date format the connection is written in, on every surface that names it. */
export function slackDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** One channel of one workspace a project alerts into: a binding, with the workspace that carries it. */
export interface SlackRoute {
  workspace: SlackWorkspace;
  binding: SlackChannelBinding;
}

/** Every workspace and channel a project alerts into; empty when it alerts nowhere. */
export function projectSlackRoutes(
  workspaces: readonly SlackWorkspace[],
  projectId: string,
): SlackRoute[] {
  return workspaces.flatMap((workspace) => workspace.bindings
    .filter((binding) => binding.projectId === projectId)
    .map((binding) => ({ workspace, binding })));
}

/**
 * The three ways Slack stops carrying a project's failures. A revoked
 * workspace silences every channel in it at once, so it is one silence however
 * many of the project's channels it holds, and those channels are not judged
 * again one by one — a project is never told two things about the same
 * connection. A refused channel is one route, so it names the project and the
 * channel both.
 */
type SlackSilence =
  | { kind: "workspace_revoked"; workspaceId: string; workspace: string; since: string; unannounced: number }
  | { kind: "install_unfinished"; since: string }
  | {
      kind: "channel_refused";
      projectId: string;
      channel: SlackChannel;
      error: SlackDeliveryError;
      unannounced: number;
    };

/** One workspace's share of a project's silences, from the project's routes through it. */
function workspaceSilences(
  workspace: SlackWorkspace,
  bindings: readonly SlackChannelBinding[],
): SlackSilence[] {
  if (bindings.length === 0) return [];
  if (workspace.revokedAt !== null) {
    return [{
      kind: "workspace_revoked",
      workspaceId: workspace.id,
      workspace: workspace.name,
      since: workspace.revokedAt,
      // Every channel lost the same runs from the one revocation on, so they
      // are counted once, not once per channel.
      unannounced: Math.max(...bindings.map((binding) => binding.unannouncedFailures)),
    }];
  }
  return bindings.flatMap((binding): SlackSilence[] => (binding.deliveryError
    ? [{
        kind: "channel_refused",
        projectId: binding.projectId,
        channel: binding.channel,
        error: binding.deliveryError,
        unannounced: binding.unannouncedFailures,
      }]
    : []));
}

/**
 * Which of this project's routes into Slack are silent, and why.
 *
 * A project that alerts somewhere is judged by its own routes: a workspace
 * stopped delivering, or one of its channels stopped accepting. A project that
 * alerts nowhere has no route to be silent, so the only thing that can be said
 * to it is that the team started an install and never finished one — which is
 * why a project already alerting through a connected workspace is never told
 * about a second install it does not depend on.
 */
export function projectSlackSilences(
  connections: SlackConnections | undefined,
  projectId: string,
): SlackSilence[] {
  const routed = (connections?.workspaces ?? []).map((workspace) => ({
    workspace,
    bindings: workspace.bindings.filter((binding) => binding.projectId === projectId),
  }));
  if (routed.every((entry) => entry.bindings.length === 0)) {
    const pending = connections?.pendingInstall;
    return pending ? [{ kind: "install_unfinished", since: pending.startedAt }] : [];
  }
  return routed.flatMap((entry) => workspaceSilences(entry.workspace, entry.bindings));
}

/** What tells one silence from another: the workspace that was revoked, or the (project, channel) route that refused. */
export function slackSilenceKey(silence: SlackSilence): string {
  if (silence.kind === "workspace_revoked") return `slack-workspace_revoked-${silence.workspaceId}`;
  if (silence.kind === "channel_refused") return `slack-channel_refused-${silence.projectId}-${silence.channel.id}`;
  return "slack-install_unfinished";
}

/**
 * What the loss was, or nothing at all. An alarm with no failures behind it is
 * noise, so a count of zero is never claimed as one.
 */
export function unannouncedClause(count: number): string | null {
  return count > 0 ? `${String(count)} ${count === 1 ? "failure" : "failures"} went unannounced` : null;
}

/** A silence in words: what stopped, what it cost, and the one thing to do about it. */
interface SlackSilenceSentence {
  title: string;
  body: string;
  actionLabel: string;
}

function revokedSentence(
  silence: Extract<SlackSilence, { kind: "workspace_revoked" }>,
  now: Date,
): SlackSilenceSentence {
  const lost = unannouncedClause(silence.unannounced);
  const removed = `ShipBash was removed from ${silence.workspace} on ${slackDate(silence.since)}`;
  return {
    title: `Slack alerts stopped ${relativeTimeLabel(silence.since, now)}`,
    body: lost ? `${removed} — ${lost}.` : `${removed}.`,
    actionLabel: "Reconnect",
  };
}

function refusedSentence(
  silence: Extract<SlackSilence, { kind: "channel_refused" }>,
): SlackSilenceSentence {
  const fault = DELIVERY_FAULTS[silence.error];
  const lost = unannouncedClause(silence.unannounced);
  return {
    title: `Slack alerts stopped · ${channelLabel(silence.channel)}`,
    body: `${fault.reads} — ${fault.fix}.${lost ? ` ${lost}.` : ""}`,
    actionLabel: "Fix the channel",
  };
}

/**
 * One silence, said the same way wherever it is said. Relative time is read
 * against the clock the caller is looking at, the way every other "how long
 * ago" on this page is.
 */
export function slackSilenceSentence(silence: SlackSilence, now: Date): SlackSilenceSentence {
  if (silence.kind === "workspace_revoked") return revokedSentence(silence, now);
  if (silence.kind === "channel_refused") return refusedSentence(silence);
  return {
    title: "Slack install not finished",
    body: `Started ${slackDate(silence.since)}. If this workspace needs an admin to approve ShipBash, the request is with them.`,
    actionLabel: "Check again",
  };
}

/**
 * The project's Slack silences as rows of Needs attention, one per silence.
 *
 * Attention items are for people who can do something, but silence is
 * everyone's problem, so this is not filtered by role: the action lands on a
 * pane where a member reads the state and finds no controls.
 */
export function slackAttentionItems(
  connections: SlackConnections | undefined,
  project: { id: string },
  teamHref: (pathname: string) => Route,
): AttentionItem[] {
  const now = new Date();
  return projectSlackSilences(connections, project.id).map((silence) => {
    const sentence = slackSilenceSentence(silence, now);
    return {
      id: slackSilenceKey(silence),
      title: sentence.title,
      body: sentence.body,
      actionLabel: sentence.actionLabel,
      href: teamHref("/settings/slack"),
    };
  });
}

/**
 * The team's Slack connection, read the way the Overview's other attention
 * sources read theirs. Every member may read it, so it is not gated on a role.
 */
export function useTeamSlackConnections(teamId: string) {
  return useQuery(readQuery("slackConnections", teamId));
}
