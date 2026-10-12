"use client";

import { useEffect } from "react";

import { createKeyboardSink } from "./takeover-keyboard-sink";
import { createTakeoverKeys } from "./takeover-keys";
import { createTakeoverMouse } from "./takeover-mouse";
import type { TakeoverSend } from "./takeover-protocol";

/**
 * Captures mouse, keyboard, IME, and clipboard input on the live-stream canvas
 * and translates it into the sidecar's takeover protocol. Every message rides
 * the stream WebSocket (no HTTP side channel), and mouse events carry the CDP
 * `buttons` bitmask so held-button drags express their full state.
 *
 * The lanes live beside this file: the keyboard sink that holds focus, the
 * pointer lane, and the keyboard lane. This module is the wiring — which
 * handler hangs off which target, and the teardown that takes them all down.
 */

/**
 * Keeps takeover input attached to whichever canvas the stream currently
 * renders. The canvas is a reactive value: a remounted viewport must re-attach
 * the handlers, not keep driving a detached element the user can no longer see.
 */
export function useTakeoverInput(options: {
  canvas: HTMLCanvasElement | null;
  controlling: boolean;
  send: TakeoverSend;
}): void {
  const { canvas, controlling, send } = options;
  useEffect(() => {
    if (!controlling || !canvas) return;
    const input = installTakeoverInput({ canvas, send, isActive: () => true });
    input.focus();
    return () => input.dispose();
  }, [canvas, controlling, send]);
}

interface InstallTakeoverInputOptions {
  canvas: HTMLCanvasElement;
  send: TakeoverSend;
  isActive: () => boolean;
}

function installTakeoverInput({ canvas, send, isActive }: InstallTakeoverInputOptions): {
  focus: () => void;
  dispose: () => void;
} {
  const { keyboardSink, focusKeyboard } = createKeyboardSink(canvas);
  const active = () => isActive()
    && (document.activeElement === canvas || document.activeElement === keyboardSink);
  const mouse = createTakeoverMouse({ canvas, send, isActive, focusKeyboard });
  const keys = createTakeoverKeys({ keyboardSink, send, active });
  // Both the canvas and the sink carry the text events: a paste can land on
  // either, depending on which one the host had focused.
  const textTargets: HTMLElement[] = [canvas, keyboardSink];

  const unlisten = [
    listen(canvas, "pointermove", mouse.onPointerMove),
    listen(canvas, "pointerdown", mouse.onPointerDown),
    listen(canvas, "pointerup", mouse.onPointerUp),
    listen(canvas, "pointercancel", mouse.releasePointer),
    listen(canvas, "lostpointercapture", mouse.releasePointer),
    listen(canvas, "wheel", mouse.onWheel, { passive: false }),
    listen(canvas, "contextmenu", mouse.onContextMenu),
    ...textTargets.flatMap((target) => [
      listen(target, "paste", keys.onPaste),
      listen(target, "compositionstart", keys.onCompositionStart),
      listen(target, "compositionend", keys.onCompositionEnd),
    ]),
    listenWindow("keydown", keys.onKeyDown, true),
    listenWindow("keyup", keys.onKeyUp, true),
    listenWindow("blur", mouse.releaseAllPointers),
  ];

  return {
    focus: focusKeyboard,
    dispose: () => {
      mouse.releaseAllPointers();
      for (const off of unlisten) off();
      keyboardSink.remove();
    },
  };
}

/** Adds one listener and returns what takes it off again. */
function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K,
  handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** The window's counterpart of listen. */
function listenWindow<K extends keyof WindowEventMap>(type: K,
  handler: (event: WindowEventMap[K]) => void, capture?: boolean): () => void {
  window.addEventListener(type, handler, capture);
  return () => window.removeEventListener(type, handler, capture);
}
