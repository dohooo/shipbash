"use client";

import { safeBrowserViewerUrl } from "../../lib/client-contracts";
import type { ActivityDetail } from "../../lib/web-client";
import {
  activityAuthPending,
  activityBrowserPage,
  activityFinalizing,
  cancelableActivity,
  completedBrowserActionCount,
  latestActivityEventSequence,
  latestAgentPointer,
  proposalsReviewHref,
  terminalActivities,
} from "../_lib/activity-derived";
import { steeredConversation } from "../_lib/local-steer";
import { activityCandidateCases } from "../_lib/activity-proposals";
import type { AgentChatSuggestion } from "./activity-chat";
import { discoveryStateLabel, presenceEyePlacement } from "./activity-presence";
import { activityChatFeed } from "./activity-chat";
import type { ActivityPageState } from "./activity-page-state";

/**
 * The page once both gates are open: a resolved product, and the Activity the
 * query answered with.
 */
export interface ActivityPageReady extends Omit<ActivityPageState, "project"> {
  project: NonNullable<ActivityPageState["project"]>;
  activity: ActivityDetail;
}

/**
 * The status pill's word: a live picture waiting on its stream downgrades
 * Running to Connecting — the stage keeps the last frame instead of blanking
 * (browserStageNotice), so the pill is what says the view is away. A walk
 * that completed reads Finished, in no tone: it ended, and its verdict is what
 * it found, not this pill.
 */
function displayedStatus(finalizing: boolean, streamReady: boolean, status: string): string {
  if (finalizing) return "finalizing";
  if (status === "running") return streamReady ? "running" : "connecting";
  if (status === "completed") return "finished";
  return status;
}

/**
 * What state the run is in, and what the conversation and the footer may
 * offer because of it.
 */
function activityRunModel(page: ActivityPageReady) {
  const {
    activity, teamHref, router, authQuery,
    hasAgentMessages, cloudflareBlocked, trustedAccessHref, streamReady,
  } = page;
  const viewerUrl = safeBrowserViewerUrl(authQuery.data?.authViewerUrl);
  // The service says whether a retry walks it again.
  const retryable = activity.retryable;
  const cancelable = cancelableActivity(activity.status);
  const activityTerminal = terminalActivities.has(activity.status);
  const finalizing = activityFinalizing(activity, activityTerminal);
  // A picture the runtime lets go of for a sign-in is paused on purpose, not
  // away: the pill stays on Running until the status itself says the park.
  const authPending = activityAuthPending(activity);
  const displayStatus = displayedStatus(finalizing, streamReady || authPending, activity.status);
  const agentStateLabel = discoveryStateLabel(activity.status, activityTerminal, hasAgentMessages);
  const chatMessages = activityChatFeed({ activity, terminal: activityTerminal, cloudflareBlocked });
  const proposedCases = activityCandidateCases(activity);
  // The proposals that are journeys, not the hooks around them.
  const proposedJourneys = proposedCases.filter((entry) => entry.role === "journey");
  const reviewHref = proposalsReviewHref(activity.result?.proposals ?? [], teamHref);
  // Attention-driven actions stay next to the conversation; journey decisions
  // move to the workbench footer below the content card.
  const chatSuggestions: AgentChatSuggestion[] = [];
  if (cloudflareBlocked && trustedAccessHref) {
    chatSuggestions.push({ label: "Set up access", run: () => router.push(trustedAccessHref) });
  }
  return {
    viewerUrl, retryable, cancelable, activityTerminal, finalizing, authPending, displayStatus,
    agentStateLabel, chatMessages, proposedCases, proposedJourneys, reviewHref, chatSuggestions,
  };
}

/**
 * What the stage shows: the browser's own picture of the page, the steered
 * conversation, and where the presence eye should sit.
 */
function activityStageModel(page: ActivityPageReady, finalizing: boolean) {
  const {
    activity, project, takeoverRequested, streamConnecting, steers, workbenchTab, assistantDraft,
  } = page;
  const latestEventSequence = latestActivityEventSequence(activity.events);
  const { streamUrl, streamRevision } = activity;
  const boot = { sandboxUp: activity.events.length > 0 || activity.status === "running", browserReady: streamUrl !== null };
  const {
    address: browserAddress,
    title: browserPageTitle,
    faviconUrl: browserFaviconUrl,
  } = activityBrowserPage(activity.events, project.productionUrl);
  const completedActionCount = completedBrowserActionCount(activity.events);
  const waitingForAuth = activity.status === "waiting_for_auth";
  const agentPointer = latestAgentPointer(activity.events);
  const { messages: conversationMessages, steering } = steeredConversation(
    steers,
    activity.events,
    activity.result?.recoveryAction ?? null,
  );
  // The findings are the knowledge the flow's Knowledge group counts.
  const findingCount = conversationMessages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool" && part.toolClass === "knowledge").length;
  const eye = presenceEyePlacement(
    takeoverRequested, activity.status === "running" || finalizing, steering, conversationMessages,
    workbenchTab === "terminal" ? "terminal" : "browser", assistantDraft.thinking, streamConnecting,
  );
  return {
    latestEventSequence, streamUrl, streamRevision, boot,
    browserAddress, browserPageTitle, browserFaviconUrl, completedActionCount,
    waitingForAuth, agentPointer, conversationMessages, findingCount, steering, eye,
  };
}

/**
 * Everything the Activity page reads off the loaded run. Pure — the same run
 * and the same lane state always give the same view.
 */
export function activityPageModel(page: ActivityPageReady) {
  const run = activityRunModel(page);
  return { ...run, ...activityStageModel(page, run.finalizing) };
}

export type ActivityPageModel = ReturnType<typeof activityPageModel>;
