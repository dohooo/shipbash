"use client";

import { type Dispatch, type SetStateAction, useEffect } from "react";

import type { BrowserStreamMessage } from "./browser-viewport";
import { useTakeoverInput } from "./takeover-input";

/**
 * Where a canvas gets its control lease. An Activity takeover is one source
 * and the Project's sign-in takeover is another; the canvas cannot tell them
 * apart, and must not — what turns it interactive is the lease, never which
 * page asked for it.
 */
export interface BrowserControlSource {
  /** The person asked to drive, and has not finished or canceled yet. */
  requested: boolean;
  /** Control-lease token from the grant; the runner checks it before obeying. */
  controlToken: string | null;
}

/**
 * The control lease and everything it turns on. Claiming it is the only thing
 * that makes the canvas interactive, and the same lease covers the terminal,
 * so the claim, the canvas input and the terminal's sender are one sequence:
 * losing the lease takes all three back at once.
 */
/** How long an unanswered claim waits before it is sent again. */
const CLAIM_RETRY_MS = 1_000;

export function useBrowserControl({
  shouldControl,
  controlToken,
  controlGranted,
  setControlGranted,
  gatewayConnected,
  send,
  canvas,
  inputEnabled,
  onTermControl,
}: {
  /** A takeover is on and the grant handed over a lease token. */
  shouldControl: boolean;
  controlToken: string | null;
  controlGranted: boolean;
  setControlGranted: Dispatch<SetStateAction<boolean>>;
  /** The relay has reached the runner, so a claim sent now arrives. */
  gatewayConnected: boolean;
  send: (message: BrowserStreamMessage) => boolean;
  canvas: HTMLCanvasElement | null;
  inputEnabled: boolean;
  onTermControl?: ((send: ((sessionId: string, dataBase64: string) => void) | null) => void) | undefined;
}): boolean {
  // Give the lease back the moment the request is withdrawn, and only then:
  // a reconnect is a gap in the socket, not a change of mind.
  useEffect(() => {
    if (!shouldControl || !controlToken) return;
    return () => {
      send({ type: "control_release" });
      setControlGranted(false);
    };
  }, [controlToken, send, setControlGranted, shouldControl]);
  // Claim the lease, and keep claiming until the runner answers.
  //
  // The viewer's socket opening is not the runner hearing it: the stream
  // gateway forwards a viewer's messages only once its own upstream is up, and
  // drops everything sent before that with no error of any kind. A claim sent
  // on `open` is therefore never answered and never retried — the canvas comes
  // up silently read-only while the page says the reader is driving. So the
  // claim waits for the gateway's own `connected`, goes again on every
  // reconnect, and repeats until `control_state` grants it.
  useEffect(() => {
    if (!shouldControl || !controlToken || !gatewayConnected || controlGranted) return;
    const claim = () => send({ type: "control_acquire", token: controlToken });
    claim();
    const timer = window.setInterval(claim, CLAIM_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [controlGranted, controlToken, gatewayConnected, send, shouldControl]);
  // While control is granted, the canvas captures real input and injects it
  // into the live browser over the same socket the frames arrive on.
  const controlling = shouldControl && controlGranted;
  useTakeoverInput({ canvas, controlling: controlling && inputEnabled, send });
  // The same lease covers the terminal: while controlling, the terminal panel
  // gets a sender for its keystrokes; losing control takes it back.
  useEffect(() => {
    if (!onTermControl || !controlling || !inputEnabled) return;
    onTermControl((sessionId, data) => send({ type: "term_input", sessionId, data }));
    return () => onTermControl(null);
  }, [controlling, inputEnabled, onTermControl, send]);
  return controlling;
}
