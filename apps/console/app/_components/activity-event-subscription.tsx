"use client";

import { useEffect, useEffectEvent, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { readKey } from "../../lib/queries";
import { terminalActivities } from "../_lib/activity-derived";

import {
  activityEventStreamUrl,
  mergeActivityStreamEvent,
  parseActivityStreamEvent,
  type ActivityDetail,
} from "../../lib/web-client";

/**
 * Streams one Activity's events into the query cache and closes the stream the
 * moment the Activity reaches a terminal status. Renders nothing.
 */
export function ActivityEventSubscription({
  projectId,
  activityId,
  initialAfter,
  onLiveChange,
}: {
  projectId: string;
  activityId: string;
  initialAfter: number;
  /** Whether the stream is carrying events, so the page can slow its own refetch while it is. */
  onLiveChange: (live: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [resumeAfter] = useState(initialAfter);
  // An effect event: a caller that re-creates this callback must not make the
  // EventSource reconnect.
  const reportLive = useEffectEvent(onLiveChange);
  useEffect(() => {
    const queryKey = readKey("activity", projectId, activityId);
    const source = new EventSource(activityEventStreamUrl(projectId, activityId, resumeAfter));
    source.onopen = () => reportLive(true);
    source.onerror = () => reportLive(false);
    const refreshTerminalDetail = () => {
      source.close();
      reportLive(false);
      void queryClient.invalidateQueries({ queryKey });
    };
    source.onmessage = (message) => {
      const event = parseActivityStreamEvent(message.data);
      if (!event) return;
      queryClient.setQueryData<ActivityDetail>(queryKey, (current) => (
        current ? mergeActivityStreamEvent(current, event) : current
      ));
      // An edit walk's review is the service's: a staged journey the walk
      // echoes turns ready there, so the review is read again at once.
      if (event.safeData.event === "proposal_case" && queryClient.getQueryData<ActivityDetail>(queryKey)?.review?.kind === "journey_edit") {
        void queryClient.invalidateQueries({ queryKey });
      }
      if (terminalActivities.has(event.status)) refreshTerminalDetail();
    };
    source.addEventListener("done", refreshTerminalDetail);
    return () => {
      source.removeEventListener("done", refreshTerminalDetail);
      source.close();
      reportLive(false);
    };
  }, [activityId, projectId, queryClient, resumeAfter]);
  return null;
}
