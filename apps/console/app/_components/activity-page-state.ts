"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { readQuery } from "../../lib/web-client";
import {
  activityHasAgentMessages,
  activityPollInterval,
  editWalkReview,
  retainedTerminalLogs,
  terminalActivities,
  trustedAccessHrefFor,
} from "../_lib/activity-derived";
import type { StoredActivityLayouts } from "../_lib/activity-layout";
import { useTerminalLane } from "./activity-terminal";
import type { TerminalInputSender } from "./activity-terminal-screen";
import type { WorkbenchTab } from "./discovery-workbench";
import { useActivityActions, useActivitySteer } from "./use-activity-actions";
import { useActivityLayout } from "./use-activity-layout";
import { useAssistantDraft } from "./use-assistant-draft";
import { useActivityTakeoverAuth } from "./use-activity-takeover-auth";
import { useActivityTakeoverTransition } from "./use-activity-takeover-transition";
import { useCloudflareBlockedToast } from "./use-cloudflare-blocked-toast";
import { useCompletionNotification } from "./use-completion-notification";
import { useProduct } from "./shell";

const NO_TERMINAL_LOGS: ReturnType<typeof retainedTerminalLogs> = [];

function retainedLogsFor(
  project: { id: string },
  data: { terminalLogSessionIds: readonly string[] } | undefined,
  activityId: string,
): ReturnType<typeof retainedTerminalLogs> {
  return data
    ? retainedTerminalLogs(data.terminalLogSessionIds, project.id, activityId)
    : NO_TERMINAL_LOGS;
}

/**
 * The queries and mutations the page is built on, in the order the page
 * calls them: the workspace, the Activity itself, the edit run it may
 * belong to, then the takeover session and the actions that act on the run.
 */
function useActivityCore(activityId: string) {
  const router = useRouter();
  const { project, team, teamHref } = useProduct();

  // The event stream is the live channel. While it is connected the refetch
  // only has to reconcile fields no event carries (the retained terminal
  // logs), so it drops to a slow pass; the stream's own 270s reconnect lets
  // one full refetch through, which is the reconciliation, not a fault. Once
  // the run ends, the follow-up review paces the reads, on the rule the
  // follow-up conversation's own observer of this key shares.
  const [streamLive, setStreamLive] = useState(false);
  const query = useQuery({
    ...readQuery("activity", project.id, activityId),
    refetchInterval: (state) => activityPollInterval(state.state.data, streamLive),
  });
  const editRun = editWalkReview(query.data);
  const isEditRun = editRun !== null;
  // The page's trail, once the Activity says which kind of run it is.
  const trail = query.data
    ? [
        { label: "Journeys", pathname: "/journeys" },
        { label: isEditRun ? "Edit run" : "Exploring" },
      ]
    : undefined;
  const hasAgentMessages = query.data ? activityHasAgentMessages(query.data.events) : false;
  const auth = useActivityTakeoverAuth(activityId, project, query.data?.status);
  const actions = useActivityActions({
    activityId,
    activity: query.data,
    refetch: query.refetch,
    setTakeoverRequested: auth.setTakeoverRequested,
  });
  const steerLane = useActivitySteer({ activityId, refetch: query.refetch });
  return {
    activityId, router, project, team, teamHref, query, streamLive, setStreamLive,
    editRun, isEditRun, trail, hasAgentMessages, ...auth, ...actions, ...steerLane,
  };
}

type ActivityCore = ReturnType<typeof useActivityCore>;

/**
 * The lanes the page drives beside the run: the terminal, the assistant's
 * draft, the workbench tab and stream state, and the two notifications that
 * watch the run's status.
 */
function useActivityLanes(core: ActivityCore, storedLayouts: StoredActivityLayouts) {
  const { activityId, project, team, query, teamHref, isEditRun } = core;
  // Hydrates in EVERY state: gating on a terminal status made the Terminal
  // tab vanish for a woken run's whole live round.
  const termLogs = retainedLogsFor(project, query.data, activityId);
  const { sessions: termSessions, feed: termFeed, handleTermMessage } = useTerminalLane(termLogs);
  const assistantDraft = useAssistantDraft(handleTermMessage);
  // The page holds the workbench tab so the takeover eye can park at the
  // surface the reader is actually controlling.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("browser");
  // The bar's switch and the split below it read one layout.
  const layout = useActivityLayout(query.data?.kind, storedLayouts);
  const [streamConnecting, setStreamConnecting] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const transition = useActivityTakeoverTransition({
    requested: core.takeoverRequested,
    request: core.setTakeoverRequested,
    complete: core.completeAuth,
    // A run that ended mid-handoff has nothing to hand back to: the stage
    // returns to its terminal picture and the footer to Retry discovery.
    settled: core.cancelAuth.isSuccess
      || (query.data?.status !== undefined && terminalActivities.has(query.data.status)),
    replaceViewer: core.replaceAuthViewer,
  });
  // An Edit run opens on its draft tab: the rewritten scripts are the story.
  useEffect(() => {
    if (isEditRun) setWorkbenchTab("journeys");
  }, [isEditRun]);
  // The stream pane owns the control lease; while it holds one, it hands the
  // terminal panel this sender for keystrokes.
  const [termInput, setTermInput] = useState<TerminalInputSender | null>(null);
  const onTermControl = useCallback((send: TerminalInputSender | null) => {
    setTermInput(() => send);
  }, []);
  const cloudflareBlocked = query.data?.status === "needs_attention"
    && query.data.result?.attentionCode === "cloudflare_challenge";
  // An exploration that ended needing the reader but kept Journeys (its time
  // budget ran out): the run is over, and the Journeys still undecided are
  // what to act on; kept or discarded ones ask nothing more.
  // Only an admin manages trusted access, and only an admin's settings draw it.
  const trustedAccessHref = team.role === "admin" ? trustedAccessHrefFor(teamHref, activityId) : null;
  useCloudflareBlockedToast({ activityId, cloudflareBlocked, trustedAccessHref });
  useCompletionNotification(
    Boolean(query.data && !terminalActivities.has(query.data.status)),
    "ShipBash finished",
    "Your activity completed.",
  );
  return {
    termSessions, termFeed, assistantDraft, workbenchTab, setWorkbenchTab, ...layout,
    streamConnecting, setStreamConnecting, streamReady, setStreamReady, termInput, onTermControl,
    transition,
    cloudflareBlocked, trustedAccessHref,
  };
}

export type ActivityPageState = ActivityCore & ReturnType<typeof useActivityLanes>;

/**
 * Every hook the Activity page runs, in one call and in one order.
 * `storedLayouts` is the reader's layout per kind, as the request's cookies held it.
 */
export function useActivityPageState(activityId: string, storedLayouts: StoredActivityLayouts): ActivityPageState {
  const core = useActivityCore(activityId);
  const lanes = useActivityLanes(core, storedLayouts);
  return { ...core, ...lanes };
}
