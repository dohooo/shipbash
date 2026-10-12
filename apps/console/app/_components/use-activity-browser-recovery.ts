"use client";

import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import type { StreamViewport } from "./activity-browser-message";
import type { BrowserNavState } from "./browser-mockup-chrome";

const RETRY_DELAYS_MS = [750, 1_500, 3_000];

/** Rewire only this viewer socket, at most three times for one outage. */
export function useBoundedStreamRecovery({
  active, waitingForAuth, streamUrl, sourceHealthy, hasFrame, wasDisconnected,
}: {
  active: boolean;
  waitingForAuth: boolean;
  streamUrl: string | null;
  sourceHealthy: boolean;
  hasFrame: boolean;
  wasDisconnected: boolean;
}): { retryKey: number; unavailable: boolean; retry: () => void } {
  const [retryKey, setRetryKey] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!sourceHealthy) return;
    setAttempts(0);
    setUnavailable(false);
  }, [sourceHealthy]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a newly announced stream resets bounded retries.
  useEffect(() => {
    setAttempts(0);
    setUnavailable(false);
  }, [streamUrl]);

  useEffect(() => {
    if (!active || waitingForAuth || !streamUrl || sourceHealthy || unavailable
      || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    const delay = attempts === 0 && !hasFrame && !wasDisconnected
      ? 8_000 : RETRY_DELAYS_MS[Math.min(attempts, 2)];
    const timer = window.setTimeout(() => {
      if (attempts >= 3) {
        setUnavailable(true);
        return;
      }
      setAttempts((count) => count + 1);
      setRetryKey((key) => key + 1);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [active, attempts, hasFrame, sourceHealthy, streamUrl, unavailable, waitingForAuth, wasDisconnected]);

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible" && active && !waitingForAuth && !sourceHealthy) {
        setRetryKey((key) => key + 1);
      }
    };
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, [active, sourceHealthy, waitingForAuth]);

  return {
    retryKey,
    unavailable,
    retry: () => {
      setAttempts(0);
      setUnavailable(false);
      setRetryKey((key) => key + 1);
    },
  };
}

/** A new announced upstream invalidates readiness, but keeps old pixels. */
export function useStreamResetOnAnnounce({
  streamUrl,
  connectionKey,
  setFrameViewport,
  setNavState,
  onReset,
}: {
  streamUrl: string | null;
  connectionKey: number;
  setFrameViewport: Dispatch<SetStateAction<StreamViewport | null>>;
  setNavState: Dispatch<SetStateAction<BrowserNavState | null>>;
  onReset: () => void;
}): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: streamUrl and connectionKey are the reset triggers.
  useEffect(() => {
    setFrameViewport(null);
    setNavState(null);
    onReset();
  }, [streamUrl, connectionKey]);
}
