"use client";

import type { Dispatch, SetStateAction } from "react";

import { applyBrowserStreamMessage, type StreamViewport } from "./activity-browser-message";
import { useBrowserStream, type BrowserStreamMessage } from "./browser-viewport";
import type { ActivityBrowserMirror } from "./use-activity-browser-mirror";
import type { ActivityBrowserSurfaces } from "./use-activity-browser-surfaces";
import type { useActivityBrowserPresentation } from "./use-activity-browser-presentation";

/** The Activity socket's frame, source-health and control-state dispatch. */
export function useActivityBrowserSocket({
  streamUrl, active, waitingForAuth, connectionKey, retryKey, mirror, surfaces,
  presentationState, setStreamViewport, setFrameViewport, setWasDisconnected,
  setBlackout, markFramePainted, applyStreamMessage, onTermMessage,
}: {
  streamUrl: string | null;
  active: boolean;
  waitingForAuth: boolean;
  connectionKey: number;
  retryKey: number;
  mirror: ActivityBrowserMirror;
  surfaces: ActivityBrowserSurfaces;
  presentationState: ReturnType<typeof useActivityBrowserPresentation>;
  setStreamViewport: Dispatch<SetStateAction<StreamViewport | null>>;
  setFrameViewport: Dispatch<SetStateAction<StreamViewport | null>>;
  setWasDisconnected: Dispatch<SetStateAction<boolean>>;
  setBlackout: Dispatch<SetStateAction<boolean>>;
  markFramePainted: () => void;
  applyStreamMessage: (message: BrowserStreamMessage) => void;
  onTermMessage: (message: BrowserStreamMessage) => boolean;
}) {
  return useBrowserStream({
    streamUrl,
    enabled: active && !waitingForAuth && streamUrl !== null,
    connectionKey: `${String(connectionKey)}:${String(retryKey)}`,
    reconnectDelayMs: null,
    onFrameSize: (size) => { setFrameViewport(size); markFramePainted(); },
    onFramePainted: (frame, replayed) => {
      presentationState.framePainted(frame, replayed);
      markFramePainted();
    },
    onClose: () => {
      setWasDisconnected(true);
      surfaces.setControlDenied((current) => current ?? "stream_disconnected");
      presentationState.disconnect();
    },
    onMessage: (message) => {
      applyStreamMessage(message);
      if (onTermMessage(message)) return;
      if (message.type === "status" && typeof message.blackout === "boolean") setBlackout(message.blackout);
      applyBrowserStreamMessage(message, {
        ...surfaces,
        ...mirror,
        setStreamViewport,
        setTransportConnected: presentationState.setTransportConnected,
        setSourceConnected: (connected, sourceKey) => {
          setWasDisconnected(!connected);
          presentationState.setSourceConnected(connected, sourceKey);
        },
        markFramePending: presentationState.markFramePending,
      });
    },
  });
}
