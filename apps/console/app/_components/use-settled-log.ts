"use client";

import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * A run's log reads on once more when a read of the run finds it settled. The
 * run writes its last lines as it ends, after the last read of its log on the
 * schedule of a run still walking, and whichever read finds the run settled —
 * the event stream's last frame, a poll, a cancel — the log then reads what it
 * gained since its own cursor. A page that opens on a settled run read its log
 * whole with it, and reads nothing more.
 */
export function useSettledLog(settled: boolean, logKey: QueryKey): void {
  const queryClient = useQueryClient();
  const wasSettled = useRef(settled);
  useEffect(() => {
    if (settled && !wasSettled.current) void queryClient.invalidateQueries({ queryKey: logKey });
    wasSettled.current = settled;
  }, [logKey, queryClient, settled]);
}
