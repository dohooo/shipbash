"use client";

import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  type BrowserStreamMessage,
  createBrowserStreamConnection,
} from "./browser-stream-connection";
import type { PaintedBrowserFrame } from "./browser-presentation";

export type { BrowserStreamMessage };

interface UseBrowserStreamOptions {
  streamUrl: string | null;
  enabled: boolean;
  connectionKey?: string | number;
  reconnectDelayMs?: number | null;
  canReconnect?: () => boolean;
  clearBeforeConnect?: boolean;
  onConnecting?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  onMessage?: (message: BrowserStreamMessage) => void;
  onFrameSize?: (size: { width: number; height: number }) => void;
  onFramePainted?: (frame: PaintedBrowserFrame, replayed: boolean) => void;
}

interface BrowserStreamRefs {
  /** The mounted canvas, or null before it mounts. Reactive: use it in deps. */
  canvas: HTMLCanvasElement | null;
  canvasRef: Ref<HTMLCanvasElement>;
  frameRef: Ref<HTMLDivElement>;
  disconnect: () => void;
  /** Sends a JSON message up the live stream socket; false when not open. */
  send: (message: BrowserStreamMessage) => boolean;
}

const NOOP = () => {};

export function useBrowserStream({
  streamUrl,
  enabled,
  connectionKey = "",
  reconnectDelayMs = null,
  canReconnect = () => true,
  clearBeforeConnect = false,
  onConnecting,
  onOpen,
  onClose,
  onError,
  onMessage,
  onFrameSize,
  onFramePainted,
}: UseBrowserStreamOptions): BrowserStreamRefs {
  // The canvas element is a REACTIVE value, not a ref read. A ref read happens
  // once when the effect runs, and a remounted viewport swaps in a fresh
  // element the effect never learns about — leaving the socket painting into
  // a detached canvas while the visible one stays blank forever on a static
  // page, with the stream, control lease and address bar all still healthy.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const canvasRef = useCallback((node: HTMLCanvasElement | null) => setCanvas(node), []);
  const frameRef = useCallback((node: HTMLDivElement | null) => setFrame(node), []);
  const stopRef = useRef<() => void>(NOOP);
  const socketRef = useRef<WebSocket | null>(null);
  const handleCanReconnect = useEffectEvent(canReconnect);
  const handleConnecting = useEffectEvent(() => onConnecting?.());
  const handleOpen = useEffectEvent(() => onOpen?.());
  const handleClose = useEffectEvent(() => onClose?.());
  const handleError = useEffectEvent(() => onError?.());
  const handleMessage = useEffectEvent((message: BrowserStreamMessage) => onMessage?.(message));
  const handleFrameSize = useEffectEvent((size: { width: number; height: number }) => onFrameSize?.(size));
  const handleFramePainted = useEffectEvent((frame: PaintedBrowserFrame, replayed: boolean) => onFramePainted?.(frame, replayed));

  const disconnect = useCallback(() => {
    stopRef.current();
  }, []);

  const send = useCallback((message: BrowserStreamMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  // connectionKey is a deliberate reset key: a new stream announcement must
  // force a fresh socket even though the effect body never reads it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectionKey is a reset key the body never reads.
  useEffect(() => {
    if (!enabled || !streamUrl) {
      stopRef.current = NOOP;
      return NOOP;
    }

    const context = canvas?.getContext("2d");
    if (!canvas || !frame || !context) {
      stopRef.current = NOOP;
      return NOOP;
    }

    const connection = createBrowserStreamConnection({
      clearBeforeConnect,
      handlers: {
        canReconnect: handleCanReconnect,
        onClose: handleClose,
        onConnecting: handleConnecting,
        onError: handleError,
        onFrameSize: handleFrameSize,
        onFramePainted: handleFramePainted,
        onMessage: handleMessage,
        onOpen: handleOpen,
      },
      reconnectDelayMs,
      socketSlot: socketRef,
      streamUrl,
      target: { canvas, context, frame },
    });
    const stop = connection.stop;
    stopRef.current = stop;
    connection.connect();

    return () => {
      if (stopRef.current === stop) stopRef.current = NOOP;
      socketRef.current = null;
      stop();
    };
  }, [canvas, clearBeforeConnect, connectionKey, enabled, frame, reconnectDelayMs, streamUrl]);

  return { canvas, canvasRef, frameRef, disconnect, send };
}

interface BrowserViewportProps {
  canvasRef: Ref<HTMLCanvasElement>;
  frameRef: Ref<HTMLDivElement>;
  takeoverActive: boolean;
  canvasAriaLabel: string;
  frameId?: string;
  canvasId?: string;
  frameHidden?: boolean;
  canvasHidden?: boolean;
  canvasTabIndex?: number;
  children?: ReactNode;
}

export function BrowserViewport({
  canvasRef,
  frameRef,
  takeoverActive,
  canvasAriaLabel,
  frameId,
  canvasId,
  frameHidden = false,
  canvasHidden = false,
  canvasTabIndex,
  children,
}: BrowserViewportProps) {
  return (
    <div
      className="browser-frame"
      id={frameId}
      data-takeover-active={String(takeoverActive)}
      hidden={frameHidden}
      ref={frameRef}
    >
      <canvas
        id={canvasId}
        width="1280"
        height="720"
        tabIndex={canvasTabIndex}
        role="img"
        aria-label={canvasAriaLabel}
        hidden={canvasHidden}
        ref={canvasRef}
      />
      {children}
    </div>
  );
}
