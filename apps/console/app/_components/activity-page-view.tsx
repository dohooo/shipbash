"use client";

import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";
import { createClientIntentKey } from "../../lib/web-client";
import { activityAuthPending, latestAgentSurface } from "../_lib/activity-derived";
import { localSteerId } from "../_lib/local-steer";
import { actionError, mutationMessage } from "../_lib/request-errors";
import { conversationLiveStatus, finishedHint } from "./activity-presence";
import { ActivityBrowserStream } from "./activity-browser-stream";
import { ActivityChat } from "./activity-chat";
import { ActivityTerminal } from "./activity-terminal";
import { ActivityEventSubscription } from "./activity-event-subscription";
import { ConversationSplit } from "./conversation/conversation-split";
import { DiscoveryConversation } from "./discovery-conversation";
import { DiscoveryWorkbench } from "./discovery-workbench";
import { DiscoveryWorkbenchActions } from "./discovery-workbench-actions";
import { JourneyEditRunActions } from "./journey-draft-tab";
import { PresenceEye } from "./presence-eye";
import { uploadAuthFile } from "./use-activity-takeover-auth";
import { TakeoverToggle } from "./takeover-toggle";
import { Status } from "./shell";
import type { ActivityPageModel, ActivityPageReady } from "./activity-page-model";

/**
 * The Activity page's surface. Every piece here reads the loaded run and its
 * model; nothing here decides anything the model did not already decide.
 */
interface ActivityViewProps {
  page: ActivityPageReady;
  model: ActivityPageModel;
}

/**
 * The Stop in flight or on the record. The click holds "Stopping…" until the
 * detail carries wrap_up_requested_at, and a refresh keeps it from there. A
 * terminal run has nothing left to stop, and a DELIVERED one must take the
 * message that wakes it, so the record stops counting at the end.
 */
function stoppingRun(page: ActivityPageReady, activityTerminal: boolean): boolean {
  return !activityTerminal
    && (page.stop.isPending || page.stop.data?.stopped === "wrapping_up" || page.activity.wrapUpRequestedAt !== null);
}

/**
 * Attention-driven actions stay next to the conversation; journey decisions
 * live here, in the workbench footer below the content card.
 */
function ActivityWorkbenchFooter({ page, model }: ActivityViewProps) {
  const {
    activity, transition, cloudflareBlocked,
    retry, sendInstruction, stop,
  } = page;
  const { retryable, proposedCases, reviewHref, activityTerminal, cancelable } = model;
  return (
    <>
    <TakeoverToggle phase={transition.phase} status={activity.status}
      onStart={transition.start} onRelease={transition.release} />
    {transition.phase === "error" || page.sessionUnreachable || page.authRefusal ? (
      <button className="button primary" type="button" onClick={() => {
        if (transition.phase === "error") transition.retry();
        page.retryAuth();
        void page.authQuery.refetch();
      }}>Retry</button>
    ) : null}
    {transition.phase === "error" ? <button className="button" type="button"
      disabled={page.cancelAuth.isPending} onClick={() => page.cancelAuth.mutate()}>Cancel takeover</button> : null}
    {transition.phase === "agent" ? <DiscoveryWorkbenchActions
      status={activity.status}
      retryable={retryable}
      cloudflareBlocked={cloudflareBlocked}
      retryPending={retry.isPending}
      onRetry={() => retry.mutate()}
      discoverMorePending={sendInstruction.isPending}
      onDiscoverMore={() => sendInstruction.mutate("Discover more essential user journeys beyond the ones already proposed.")}
      draftCount={proposedCases.length}
      // Editing waits for the agent: a live round rewrites the list at its
      // close, so review opens only once the run is no longer working.
      reviewHref={reviewHref && activityTerminal ? reviewHref : null}
      // Stop asks the service to stop the run, and it says how: a Discovery
      // at work wraps up (the agent is told at once, records what it has and
      // stops, and the host ends a leg still running a minute later); any
      // other run is canceled. "Stopping…" holds from the click, and for a
      // wrap-up from the record, until the run's own status ends; the
      // mutation is reset once the run is terminal.
      stop={!activityTerminal && cancelable ? {
        stopping: stoppingRun(page, activityTerminal),
        error: stop.isError ? mutationMessage(stop.error) : null,
        onStop: () => stop.mutate(),
      } : null}
    /> : null}
    </>
  );
}

/** The live picture of the run's own browser, and the takeover over it. */
function ActivityStageBrowser({ page, model }: ActivityViewProps) {
  const {
    activity, activityId, project, takeoverRequested, authQuery, authRefusal, sessionUnreachable,
    retryAuth, assistantDraft, onTermControl, setStreamConnecting, setStreamReady,
    completeAuth, transition,
  } = page;
  const {
    finalizing, authPending, streamUrl, streamRevision, waitingForAuth, activityTerminal,
    browserAddress, browserPageTitle, browserFaviconUrl, agentPointer, viewerUrl,
  } = model;
  return (
    <ActivityBrowserStream
      key={activityId}
      // While finalizing, the runner has already closed the remote
      // browser; keeping the socket URL would loop failed reconnects.
      streamUrl={finalizing ? null : streamUrl}
      connectionKey={streamRevision}
      waitingForAuth={waitingForAuth}
      authPending={authPending}
      finalizing={finalizing}
      active={!activityTerminal}
      address={browserAddress}
      reportedTitle={browserPageTitle}
      reportedFaviconUrl={browserFaviconUrl}
      finalScreenshotUrl={activity.finalScreenshotUrl}
      pointer={agentPointer}
      transitionPhase={transition.phase}
      frozenSnapshot={transition.snapshot}
      onControlReady={transition.controlReady}
      onControlLost={transition.controlLost}
      onFrozen={transition.frozen}
      onPresentationChange={(presentation) => {
        transition.presentationChanged(presentation);
        setStreamReady(presentation.ready);
      }}
      takeover={takeoverRequested ? {
        requested: true,
        controlToken: authQuery.data?.controlToken ?? null,
        fallbackViewerUrl: viewerUrl,
        // Only while no answer is held: a poll in flight leaves the last one on screen.
        preparing: authQuery.isPending && !authRefusal,
        error: sessionUnreachable
          ? "The browser session is no longer reachable. Cancel the takeover, then retry this Activity."
          : authRefusal
            ? actionError(authRefusal)
            // A refused save: the reason, over the viewer the service reopened.
            : completeAuth.isError ? actionError(completeAuth.error) : null,
        onRetryPrepare: () => {
          retryAuth();
          void authQuery.refetch();
        },
        uploadFile: (file) => uploadAuthFile(project.id, activityId, file),
      } : null}
      onTermMessage={assistantDraft.onStreamMessage}
      onTermControl={onTermControl}
      onConnectionState={setStreamConnecting}
    />
  );
}

/** The workbench: the browser, the terminal, the journeys, and the footer. */
function ActivityStage({ page, model }: ActivityViewProps) {
  const {
    activity, project, teamHref, editRun, workbenchTab, setWorkbenchTab,
    termSessions, termFeed, termInput, transition,
  } = page;
  const { activityTerminal, proposedCases, displayStatus } = model;
  return (
    <div className="activity-main">
      <DiscoveryWorkbench
          draftTab={editRun}
          tab={workbenchTab}
          onTabChange={setWorkbenchTab} agentSurface={latestAgentSurface(activity.events)}
          browser={
            <ActivityStageBrowser page={page} model={model} />
          }
          terminal={termSessions.length ? (
            <ActivityTerminal
              sessions={termSessions}
              feed={termFeed}
              live={!activityTerminal}
              input={termInput}
            />
          ) : null}
          journeys={proposedCases}
          working={!activityTerminal}
          statusSlot={<Status status={displayStatus} pill />}
          actions={editRun && transition.phase === "agent" ? (
            <JourneyEditRunActions
              projectId={project.id}
              walkId={activity.id}
              review={editRun}
              journeysHref={teamHref("/journeys")}
            />
          ) : <ActivityWorkbenchFooter page={page} model={model} />}
        />
    </div>
  );
}

/**
 * The conversation column of the activity split — the half the reader talks
 * to. A kind that converses (a discovery, a conversation) talks back, so it
 * reads as a conversation; every other activity reads as a chat.
 */
function ActivityConversationColumn({ page, model }: ActivityViewProps) {
  const {
    activity, activityId, project, assistantDraft, sendInstruction, followUp,
    streamConnecting, steer, steers, cancel, query,
  } = page;
  const {
    activityTerminal, eye, conversationMessages, boot, chatMessages,
    agentStateLabel, chatSuggestions, steering, waitingForAuth, finalizing,
    completedActionCount, browserPageTitle, cancelable, proposedJourneys, findingCount,
  } = model;
  // The drafts this run left undecided: a message about them is asked of a walk.
  const draftsId = activity.review?.kind === "drafts" && activity.review.reason !== "DRAFTS_DECIDED"
    ? activity.review.proposalId : null;
  const sendBusy = sendInstruction.isPending || followUp.isPending;
  const finished = activity.status === "completed"
    ? finishedHint(activity.kind, proposedJourneys.length, findingCount)
    : null;
  const liveStatus = conversationLiveStatus({
    revising: followUp.isPending,
    steering,
    typing: eye.slot === "composer" && eye.mode === "working",
    thinking: assistantDraft.thinking,
    running: activity.status === "running", reconnecting: streamConnecting,
    waitingForAuth,
    authPending: activityAuthPending(activity),
    finalizing,
    activityTerminal,
    completedActionCount,
    browserPageTitle,
  });
  // A message steers the run while the service says it takes one (a live run
  // folds it in, a delivered Discovery wakes with it). Otherwise it asks a
  // walk for changes to the drafts still undecided, else starts a fresh
  // discovery.
  const onSend = (text: string) => {
    if (activity.steerable) {
      steer.mutate({ message: text, clientKey: createClientIntentKey() });
    } else if (draftsId) followUp.mutate({ proposalId: draftsId, text });
    else sendInstruction.mutate(text);
  };
  return (
    <div className="activity-side">
      {activityKnowledgeSurface(activity.kind).interacts ? (
        <DiscoveryConversation
          projectId={project.id}
          activityId={activityId}
          messages={conversationMessages}
          boot={boot}
          draft={assistantDraft.draft}
          active={!activityTerminal}
          pendingQuestion={activity.pendingQuestion}
          emptyHint={agentStateLabel}
          onSend={onSend}
          onRetryMessage={(messageId) => {
            const entry = steers.find((candidate) => localSteerId(candidate.clientKey) === messageId);
            if (entry) steer.mutate({ message: entry.message, clientKey: entry.clientKey });
          }}
          sendBusy={sendBusy}
          suggestions={chatSuggestions}
          onSettled={() => void query.refetch()}
          liveStatus={liveStatus}
          finishedHint={finished}
          wrappingUp={stoppingRun(page, activityTerminal)}
        />
      ) : (
        <ActivityChat
          messages={chatMessages}
          suggestions={chatSuggestions}
          active={!activityTerminal}
          emptyHint={agentStateLabel}
          onSend={onSend}
          sendBusy={sendBusy}
          onStop={cancelable ? () => cancel.mutate() : null}
          liveStatus={liveStatus}
        />
      )}
    </div>
  );
}

/** The whole page once the run has loaded: the stage and the conversation. */
export function ActivityPageBody({ page, model }: ActivityViewProps) {
  const { activity, project, setStreamLive, layout, layoutSwitched } = page;
  const { activityTerminal, latestEventSequence, eye } = model;
  return (
    <div className="page activity-page">
      {!activityTerminal ? (
        <ActivityEventSubscription
          key={`${project.id}:${activity.id}`}
          projectId={project.id}
          activityId={activity.id}
          initialAfter={latestEventSequence}
          onLiveChange={setStreamLive}
        />
      ) : null}
      <PresenceEye slot={eye.slot} mode={eye.mode}>
        <ConversationSplit
          stage={<ActivityStage page={page} model={model} />}
          conversation={<ActivityConversationColumn page={page} model={model} />}
          collapsed={layout === "stage"}
          animated={layoutSwitched}
        />
      </PresenceEye>
    </div>
  );
}
