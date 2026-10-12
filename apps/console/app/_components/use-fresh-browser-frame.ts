"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { BrowserStreamMessage } from "./browser-viewport";

/** One fresh-frame request per healthy-but-unpainted source, then explicit Retry. */
export function useFreshBrowserFrame({
  active, waitingForAuth, streamUrl, connectionKey, sourceHealthy, blackout,
  transportConnected, ready, send, reconnectViewer,
}: {
  active: boolean;
  waitingForAuth: boolean;
  streamUrl: string | null;
  connectionKey: number;
  sourceHealthy: boolean;
  blackout: boolean;
  transportConnected: boolean;
  ready: boolean;
  send: (message: BrowserStreamMessage) => boolean;
  reconnectViewer: () => void;
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const pendingRetry = useRef(false);
  const request = useEffectEvent(() => send({ type: "stream_retry" }));
  const reconnect = useEffectEvent(reconnectViewer);

  useEffect(() => {
    if (ready) setStage(0);
  }, [ready]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new stream identity resets frame recovery.
  useEffect(() => {
    pendingRetry.current = false;
    setStage(0);
  }, [connectionKey, streamUrl]);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!active || waitingForAuth || !sourceHealthy || blackout || ready || stage === 2 || !visible) return;
    const timer = window.setTimeout(() => {
      if (stage === 1) { setStage(2); return; }
      if (!request()) {
        pendingRetry.current = true;
        reconnect();
      }
      setStage(1);
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [active, blackout, ready, sourceHealthy, stage, visible, waitingForAuth]);

  useEffect(() => {
    if (!transportConnected || !pendingRetry.current) return;
    if (request()) pendingRetry.current = false;
  }, [transportConnected]);

  return {
    unavailable: stage === 2,
    retry: () => {
      setStage(0);
      if (!transportConnected || !send({ type: "stream_retry" })) {
        pendingRetry.current = true;
        reconnectViewer();
      }
    },
  };
}
