"use client";

import { useEffect, useRef, useState } from "react";

import { isRecord } from "../../lib/is-record";
import type { BrowserLayoutState } from "./live-run-browser";

import { browserSourceKey, paintedBrowserFrame, type BrowserPresentation } from "./browser-presentation";

type LiveMessage = Record<string, unknown>;

function initialPresentation(): BrowserPresentation {
  return { sourceKey: "", transportConnected: false, sourceConnected: false, displayed: null, ready: false };
}

function sourceWasHidden(changed: boolean, connected: boolean, blackout: boolean): boolean {
  return changed || !connected || blackout;
}

/** The live browser of `runId` behind a share link. */
function liveStreamUrl(token: string, runId: string): string {
  return `/api/public/verifications/${encodeURIComponent(token)}/live?run=${encodeURIComponent(runId)}`;
}

/**
 * The live browser of `runId`, the run the report names live. Another run to
 * watch is another stream, drawn from nothing rather than over this one's
 * picture.
 */
export function usePublicBrowser(token: string, runId: string, enabled: boolean): BrowserLayoutState {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const presentationRef = useRef<BrowserPresentation>(initialPresentation());
  const [presentation, setPresentation] = useState<BrowserPresentation>(initialPresentation);
  const [waitingForAuth, setWaitingForAuth] = useState(false);
  const [blackout, setBlackout] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let currentBlackout = false;
    let currentWaitingForAuth = false;
    let revision = 0;
    let latest: { sourceKey: string; generation: number; sequence: number } | null = null;
    const source = new EventSource(liveStreamUrl(token, runId));
    const update = (next: BrowserPresentation) => {
      presentationRef.current = next;
      setPresentation(next);
    };
    const handleHealth = (value: LiveMessage) => {
      if (value.type === "run_state") {
        currentWaitingForAuth = value.waitingForAuth === true;
        setWaitingForAuth(currentWaitingForAuth);
        if (currentWaitingForAuth) {
          revision += 1;
          latest = null;
          update({ ...presentationRef.current, ready: false });
        }
        return;
      }
      if (value.type === "gateway_status") {
        const connected = value.upstream === "connected";
        if (!connected) { revision += 1; latest = null; }
        update({ ...presentationRef.current, transportConnected: connected,
          sourceConnected: connected && presentationRef.current.sourceConnected,
          ready: presentationRef.current.ready && connected });
        return;
      }
      if (value.type === "status") {
        const key = browserSourceKey(value);
        if (!key) return;
        const connected = value.connected === true && value.screencasting === true;
        const changed = key !== presentationRef.current.sourceKey;
        if (sourceWasHidden(changed, connected, value.blackout === true)) { revision += 1; latest = null; }
        currentBlackout = value.blackout === true;
        setBlackout(currentBlackout);
        update({ ...presentationRef.current, sourceKey: key, sourceConnected: connected,
          ready: !changed && connected && value.blackout !== true && presentationRef.current.ready });
      }
    };
    const handleFrame = (value: LiveMessage) => {
      if (typeof value.data !== "string") return;
      const frame = paintedBrowserFrame(value);
      if (!frame || currentWaitingForAuth || currentBlackout || !presentationRef.current.transportConnected
          || !presentationRef.current.sourceConnected || frame.sourceKey !== presentationRef.current.sourceKey) return;
      if (latest && frame.sourceKey === latest.sourceKey
        && (frame.generation < latest.generation
          || (frame.generation === latest.generation && frame.sequence <= latest.sequence))) return;
      latest = frame;
      const frameRevision = ++revision;
      const image = new Image();
      image.onload = () => {
        if (stopped || frameRevision !== revision || currentWaitingForAuth || currentBlackout
          || !presentationRef.current.transportConnected || !presentationRef.current.sourceConnected
          || frame.sourceKey !== presentationRef.current.sourceKey) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        if (frameRef.current) frameRef.current.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
        context.drawImage(image, 0, 0);
        setSize({ width: image.naturalWidth, height: image.naturalHeight });
        const current = presentationRef.current;
        update({ ...current, displayed: frame,
          ready: value.replayed !== true && current.transportConnected && current.sourceConnected && !currentBlackout });
      };
      image.src = `data:image/jpeg;base64,${value.data}`;
    };
    source.onerror = () => {
      revision += 1; latest = null;
      update({ ...presentationRef.current, transportConnected: false, sourceConnected: false, ready: false });
    };
    source.onmessage = (event) => {
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { return; }
      if (!isRecord(value)) return;
      if (value.type === "frame") handleFrame(value);
      else handleHealth(value);
    };
    return () => {
      stopped = true; revision += 1; source.close();
      update(initialPresentation()); setWaitingForAuth(false); setBlackout(false); setSize(null);
    };
  }, [token, runId, enabled]);
  const label = waitingForAuth ? "Waiting for sign-in" : blackout ? "Browser temporarily hidden"
    : presentation.ready ? "Live browser" : "Connecting to browser";
  return publicBrowserState({ canvasRef, frameRef, presentation, size, label });
}

function publicBrowserState({ canvasRef, frameRef, presentation, size, label }: {
  canvasRef: BrowserLayoutState["canvasRef"]; frameRef: BrowserLayoutState["frameRef"];
  presentation: BrowserPresentation; size: BrowserLayoutState["frameViewport"]; label: string;
}): BrowserLayoutState {
  return {
    canvasRef, frameRef, placeholderLabel: label, canvasHidden: !presentation.ready,
    address: presentation.ready ? presentation.displayed?.url ?? "" : "",
    title: label,
    frameViewport: presentation.ready ? size : null,
    streamViewport: presentation.ready ? size : null,
    handbackPicture: null,
    streamHealth: presentation.ready ? "connected" : "connecting",
  };
}
