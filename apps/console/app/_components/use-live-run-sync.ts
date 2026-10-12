"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { safeBrowserStreamUrl } from "../../lib/client-contracts";
import { parseRunStreamMessage, type RunStreamMessage } from "../../lib/run-events";
import { readQuery } from "../../lib/web-client";
import type { LiveRunViewModel, RunEventView } from "@shipbash/contracts/api/view-types";
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import { TERMINAL_RUN_STATUSES } from "../_lib/run-report";
import type { AgentPointerSignal } from "./agent-cursor";
import {
  CASE_STATUSES,
  RUN_STATUSES,
  VERDICTS,
  parseEventKind,
  parseEventLevel,
  eventTimestamp,
  redact,
  streamArtifacts,
  streamChecklist,
  streamPointer,
} from "./live-run-stream";

function streamEvent(data: RunStreamMessage, eventId: string): RunEventView {
  return {
    id: eventId,
    eventType: redact(data.eventType),
    kind: parseEventKind("kind" in data ? data.kind : "system"),
    level: parseEventLevel("level" in data ? data.level : "info"),
    summary: redact("summary" in data ? data.summary : "Run status updated"),
    detail: "detail" in data && data.detail ? redact(data.detail) : null,
    timestamp: eventTimestamp("timestamp" in data ? data.timestamp : new Date()),
    artifacts: streamArtifacts("artifacts" in data ? data.artifacts : []),
  };
}

/**
 * Each row takes what its snapshot Case's frame says, including the walk now
 * on show: a Case walked again — a hook run around every Journey, a
 * Journey walked again to reproduce — gets a new walk each time. A row the
 * page was asked to open on an earlier walk stays on that walk. The hooks
 * scoped to a row follow it onto its new walk.
 */
function mergeStreamCases(
  current: LiveRunViewModel["cases"],
  updates: RunStreamMessage["cases"],
): LiveRunViewModel["cases"] {
  const bySnapshotCase = new Map(updates.map((suiteCase) => [suiteCase.snapshotCaseId, suiteCase]));
  const walkIds = new Map<string, string>();
  const merged = current.map((suiteCase) => {
    const update = suiteCase.supersededBy === null ? bySnapshotCase.get(suiteCase.snapshotCaseId) : undefined;
    if (!update) return suiteCase;
    if (update.id !== suiteCase.id) walkIds.set(suiteCase.id, update.id);
    const status = CASE_STATUSES.has(update.status) ? update.status : suiteCase.status;
    const verdict = update.verdict === null
      ? null
      : VERDICTS.has(update.verdict) ? update.verdict : suiteCase.verdict;
    return {
      ...suiteCase,
      id: update.id,
      status,
      verdict,
      detail: {
        ...suiteCase.detail,
        checklist: streamChecklist(update.detail.checklist) ?? suiteCase.detail.checklist,
        startedAt: update.detail.startedAt,
        completedAt: update.detail.completedAt,
      },
    };
  });
  return merged.map((suiteCase) => {
    const scope = suiteCase.scopeCaseId === null ? undefined : walkIds.get(suiteCase.scopeCaseId);
    return scope ? { ...suiteCase, scopeCaseId: scope } : suiteCase;
  });
}

function mergeRunStreamMessage(current: LiveRunViewModel, data: RunStreamMessage): LiveRunViewModel {
  const status = RUN_STATUSES.has(data.status) ? data.status : current.status;
  return {
    ...current,
    status,
    verdict: data.verdict && VERDICTS.has(data.verdict) ? data.verdict : current.verdict,
    streamUrl: safeBrowserStreamUrl(data.streamUrl) ?? current.streamUrl,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
    currentCaseRunId: data.currentCaseRunId,
    takeoverActive: status === "waiting_for_auth"
      ? data.takeoverActive || current.takeoverActive
      : false,
    authViewerUrl: status === "waiting_for_auth" ? current.authViewerUrl : null,
    cases: mergeStreamCases(current.cases, data.cases),
  };
}

/**
 * The push channel that keeps the polled run view current: the run's SSE
 * event stream, writing the run's state into the same React Query cache entry
 * the page reads, and each frame's log line to the page (`appendEvent`). The
 * page's log (`verificationLog`) is only ever what its own reads returned; the
 * page reads it on once it finds the run settled (`useSettledLog`). The stream
 * opens once that log is read, on the event it ends with.
 * The auth-viewer bridge lives on the takeover session page; the run page
 * neither starts nor embeds the private browser.
 */

export function useRunEventStream({
  controlEndpoint,
  projectId,
  runId,
  initialLastEventSequence,
  seenEventIds,
  runStatusRef,
  appendEvent,
  applyPointerFallback,
  onStreamReady,
  onLiveChange,
}: {
  controlEndpoint: string;
  projectId: string;
  runId: string;
  /** The last event of the log the page holds; null until it holds one, and no stream opens. */
  initialLastEventSequence: number | null;
  seenEventIds: Set<string>;
  runStatusRef: { current: SuiteRunStatus };
  /** Where a frame's log line goes: the page's lines the stream brought, beside its log. */
  appendEvent: (event: RunEventView) => void;
  applyPointerFallback: (candidate: AgentPointerSignal | null) => void;
  onStreamReady: () => void;
  /** Whether the stream is carrying events, so the page can slow its own refetch while it is. */
  onLiveChange: (live: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const collaboratorsRef = useRef({
    appendEvent,
    applyPointerFallback,
    onStreamReady,
    onLiveChange,
    runStatusRef,
    seenEventIds,
  });

  useEffect(() => {
    collaboratorsRef.current = {
      appendEvent,
      applyPointerFallback,
      onStreamReady,
      onLiveChange,
      runStatusRef,
      seenEventIds,
    };
  }, [appendEvent, applyPointerFallback, onLiveChange, onStreamReady, runStatusRef, seenEventIds]);

  useEffect(() => {
    if (initialLastEventSequence === null) return;
    const { queryKey } = readQuery("verification", projectId, runId);
    const source = new EventSource(
      `${controlEndpoint}/events?after=${encodeURIComponent(String(initialLastEventSequence))}`,
    );
    const reportLive = (live: boolean) => collaboratorsRef.current.onLiveChange(live);
    source.onopen = () => reportLive(true);
    source.onerror = () => reportLive(false);
    source.onmessage = (message) => {
      const data = parseRunStreamMessage(message.data);
      if (!data) return;
      const collaborators = collaboratorsRef.current;
      const eventId = "id" in data ? data.id : "";
      if (eventId && collaborators.seenEventIds.has(eventId)) return;
      const nextStatus = RUN_STATUSES.has(data.status) ? data.status : null;
      const wasSettled = TERMINAL_RUN_STATUSES.has(collaborators.runStatusRef.current);
      queryClient.setQueryData(queryKey, (current) => current && {
        view: mergeRunStreamMessage(current.view, data),
      });
      collaborators.appendEvent(streamEvent(data, eventId));
      if (nextStatus) collaborators.runStatusRef.current = nextStatus;
      const eventType = data.eventType;
      if (eventType === "agent_pointer") {
        const pointer = streamPointer(data.pointer, eventId || `pointer-${String(Date.now())}`);
        if (pointer) collaborators.applyPointerFallback(pointer);
      }
      if (eventType === "browser_stream_ready") collaborators.onStreamReady();
      // The stream says what changed, not what the settled run holds: its
      // result, finalization and recordings. The page turns into the report
      // on the frame that ends the run, so it reads the run again at once —
      // which also drops a poll still in flight that would say it is running.
      // Every frame of that last tick says the run ended; one read will do.
      if (!wasSettled && nextStatus && TERMINAL_RUN_STATUSES.has(nextStatus)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    const handleDone = () => {
      source.close();
      reportLive(false);
    };
    source.addEventListener("done", handleDone);
    return () => {
      source.removeEventListener("done", handleDone);
      source.close();
      reportLive(false);
    };
  }, [controlEndpoint, initialLastEventSequence, projectId, queryClient, runId]);
}
