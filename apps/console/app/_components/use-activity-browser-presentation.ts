"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import type { BrowserPresentation, PaintedBrowserFrame } from "./browser-presentation";

/** Owns the viewer's painted frame, pending navigation and independent health. */
export function useActivityBrowserPresentation({
  onPresentationChange, setDisplayedFrame, onSourceUnavailable,
}: {
  onPresentationChange: ((presentation: BrowserPresentation) => void) | undefined;
  setDisplayedFrame: (frame: PaintedBrowserFrame) => void;
  onSourceUnavailable: () => void;
}) {
  const [presentation, setPresentation] = useState<BrowserPresentation>({
    sourceKey: "", transportConnected: false, sourceConnected: false, displayed: null, ready: false,
  });
  const pendingPage = useRef<{ tabId: string | null; url: string } | null>(null);
  const sourceKeyRef = useRef("");
  const notify = useEffectEvent((value: BrowserPresentation) => onPresentationChange?.(value));
  useEffect(() => notify(presentation), [presentation]);

  const reset = () => setPresentation((current) => ({
    ...current, transportConnected: false, sourceConnected: false, ready: false,
  }));
  const disconnect = () => {
    onSourceUnavailable();
    reset();
  };
  const setTransportConnected = (connected: boolean) => setPresentation((current) => ({
    ...current, transportConnected: connected, ready: current.ready && connected,
  }));
  const setSourceConnected = (connected: boolean, sourceKey: string | null) => {
    if (sourceKey && sourceKey !== sourceKeyRef.current) {
      sourceKeyRef.current = sourceKey;
      pendingPage.current = null;
    }
    if (!connected) onSourceUnavailable();
    setPresentation((current) => ({
      ...current,
      sourceKey: sourceKey ?? current.sourceKey,
      sourceConnected: connected,
      ready: current.ready && connected && (sourceKey === null || sourceKey === current.sourceKey),
    }));
  };
  const markFramePending = (tabId: string | null, url: string) => {
    pendingPage.current = { tabId, url };
    setPresentation((current) => !current.displayed
      || (current.displayed.url === url && (tabId === null || current.displayed.tabId === tabId))
      ? current : { ...current, ready: false });
  };
  const framePainted = (frame: PaintedBrowserFrame, replayed: boolean) => {
    if (sourceKeyRef.current !== frame.sourceKey) return;
    const pending = pendingPage.current;
    const matchesPending = pending === null || (frame.url === pending.url
      && (pending.tabId === null || frame.tabId === pending.tabId));
    if (matchesPending) pendingPage.current = null;
    setDisplayedFrame(frame);
    setPresentation((current) => current.sourceKey !== frame.sourceKey ? current : {
      ...current,
      displayed: frame,
      ready: !replayed && matchesPending && current.transportConnected && current.sourceConnected,
    });
  };

  return {
    presentation, disconnect, reset, setTransportConnected, setSourceConnected,
    markFramePending, framePainted,
  };
}
