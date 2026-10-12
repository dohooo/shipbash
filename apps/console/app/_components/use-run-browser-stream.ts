"use client";

import { useState } from "react";

import type { RunEventView } from "@shipbash/contracts/api/view-types";
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import { useBrowserStream, type BrowserStreamMessage } from "./browser-viewport";
import { isTerminal } from "./live-run-stream";
import {
  browserLogEvent,
  browserPageRevision,
  streamViewportSize,
} from "./run-browser-stream-messages";

/** No terminal lane listening: every message stays with the browser switch. */
const NO_TERMINAL_LANE = () => false;

/**
 * The run page's read-only browser mirror: the canvas socket plus the page
 * state it reflects (address, title, viewport, gateway health) and the
 * sanitized command/result/console rows it feeds into the execution log.
 */
export function useRunBrowserStream({
  browserStreamUrl,
  streamRevision,
  runStatusRef,
  projectName,
  appendEvent,
  applyPointerStreamMessage,
  onTermMessage = NO_TERMINAL_LANE,
  onFreshFrame,
}: {
  browserStreamUrl: string | null;
  streamRevision: number;
  runStatusRef: { current: SuiteRunStatus };
  projectName: string;
  appendEvent: (event: RunEventView) => void;
  applyPointerStreamMessage: (message: BrowserStreamMessage) => void;
  /** Offered every message before the browser switch; consumes the term_*
   * types. The lane's state lives with the page (useTerminalLane) so the
   * workbench can render the Terminal tab outside this hook — the same split
   * the Activity page makes in ActivityBrowserStream. */
  onTermMessage?: (message: BrowserStreamMessage) => boolean;
  onFreshFrame?: () => void;
}) {
  const [browserAddress, setBrowserAddress] = useState("Connecting to browser…");
  const [browserTitle, setBrowserTitle] = useState(projectName || "ShipBash browser");
  const [streamViewport, setStreamViewport] = useState<{ width: number; height: number } | null>(null);
  const [frameViewport, setFrameViewport] = useState<{ width: number; height: number } | null>(null);
  const [streamHealth, setStreamHealth] = useState<"connected" | "connecting" | null>(null);

  const { canvasRef, frameRef } = useBrowserStream({
    streamUrl: browserStreamUrl,
    enabled: true,
    connectionKey: streamRevision,
    reconnectDelayMs: 500,
    canReconnect: () => !isTerminal(runStatusRef.current),
    clearBeforeConnect: true,
    onConnecting: () => setStreamHealth(null),
    onFrameSize: setFrameViewport,
    onFramePainted: (_frame, replayed) => { if (!replayed) onFreshFrame?.(); },
    onMessage: (message) => {
      applyPointerStreamMessage(message);
      if (onTermMessage(message)) return;
      if (message.type === "gateway_status") {
        setStreamHealth(message.upstream === "connected" ? "connected" : "connecting");
        return;
      }
      const revision = browserPageRevision(message);
      if (revision.address !== null) setBrowserAddress(revision.address);
      if (revision.title !== null) setBrowserTitle(revision.title);
      if (message.type === "status") {
        const size = streamViewportSize(message);
        if (size) {
          setStreamViewport((current) => (
            current?.width === size.width && current.height === size.height ? current : size
          ));
        }
        return;
      }
      const event = browserLogEvent(message);
      if (event) appendEvent(event);
    },
  });

  return {
    canvasRef,
    frameRef,
    browserAddress,
    browserTitle,
    streamViewport,
    frameViewport,
    streamHealth,
  };
}
