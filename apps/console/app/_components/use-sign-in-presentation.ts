"use client";

import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";

import type { BrowserPresentation, PaintedBrowserFrame } from "./browser-presentation";
import { PASSWORD_METHOD } from "./sign-in-methods";
import type { TakeoverPhase } from "./use-activity-takeover-transition";
import { useHeldPicture } from "./use-held-picture";
import type { Binding, SessionSignInMethod } from "./use-sign-in-binding";

/**
 * The sign-in canvas keeps its last picture through capture and verification.
 * An accepted finish gives control back at once; when a leg is checking the
 * sign-in, the picture handed back stands in until that leg paints.
 */
export function useSignInPresentation(options: {
  binding: Binding | null;
  phase: TakeoverPhase;
  setPhase: Dispatch<SetStateAction<TakeoverPhase>>;
  /** Hands the sign-in over; `accepted` hears the service's answer once it has taken it. */
  submit: (method: SessionSignInMethod, accepted: (signIn: { status: string }) => void) => void;
}) {
  const { binding, phase, setPhase, submit } = options;
  const latestFrame = useRef<PaintedBrowserFrame | null>(null);
  const releasedAfter = useRef<PaintedBrowserFrame | null>(null);
  const [latest, setLatest] = useState<BrowserPresentation | null>(null);
  /** The picture of the handback in flight. */
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const held = useHeldPicture(latest?.ready ? latest.displayed : null);
  const { hold, drop: dropHeld } = held;
  const controlReady = useCallback(() => {
    setPhase((current) => current === "claiming" ? "controlling" : current);
  }, [setPhase]);
  const controlLost = useCallback(() => {
    setPhase((current) => current === "controlling" ? "error" : current);
  }, [setPhase]);
  const release = useCallback(() => {
    if (phase !== "controlling") return;
    releasedAfter.current = latestFrame.current;
    setPhase("releasing");
  }, [phase, setPhase]);
  const frozen = useCallback((image: string | null) => {
    if (!image || !binding || binding.method === PASSWORD_METHOD) {
      setPhase("error");
      return;
    }
    setSnapshot(image);
    submit(binding.method, (signIn) => {
      setPhase("agent");
      setSnapshot(null);
      if (signIn.status === "verifying") hold(image, releasedAfter.current);
    });
  }, [binding, hold, setPhase, submit]);
  const presentationChanged = useCallback((presentation: BrowserPresentation) => {
    if (presentation.displayed) latestFrame.current = presentation.displayed;
    setLatest(presentation);
  }, []);
  const drop = useCallback(() => {
    setSnapshot(null);
    dropHeld();
  }, [dropHeld]);
  return { phase, snapshot: snapshot ?? held.picture, controlReady, controlLost, release, frozen,
    presentationChanged, drop };
}
