"use client";

import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

import type { BrowserPresentation, PaintedBrowserFrame } from "./browser-presentation";
import { reopenedViewerUrl } from "../_lib/request-errors";
import { useHeldPicture } from "./use-held-picture";

export type TakeoverPhase = "agent" | "claiming" | "controlling" | "releasing" | "error";

interface ActivityTransitionOptions {
  requested: boolean;
  request: (value: boolean) => void;
  complete: { mutateAsync: () => Promise<unknown>; reset: () => void };
  /** The takeover is over for good — the reader canceled it, or the run
   * reached a terminal status — so phase and picture return to the agent's,
   * and the page's terminal branch takes the stage back. */
  settled: boolean;
  replaceViewer: (url: string) => void;
}

function useTransitionEffects(options: {
  settled: boolean;
  requested: boolean;
  phase: TakeoverPhase;
  request: (value: boolean) => void;
  generation: RefObject<number>;
  dropHeld: () => void;
  setEpoch: Dispatch<SetStateAction<number>>;
  setPhase: Dispatch<SetStateAction<TakeoverPhase>>;
  setSnapshot: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
}) {
  const { settled, requested, phase, request, generation, dropHeld, setEpoch, setPhase, setSnapshot, setError } = options;
  // A claim asked for from outside starts, like start(), with nothing held.
  useEffect(() => {
    if (!requested || phase !== "agent") return;
    dropHeld();
    setPhase("claiming");
  }, [dropHeld, phase, requested, setPhase]);
  useEffect(() => {
    if (!settled) return;
    generation.current += 1;
    setEpoch(generation.current);
    setPhase("agent");
    setSnapshot(null);
    dropHeld();
    setError(null);
    request(false);
  }, [settled, generation, dropHeld, request, setEpoch, setError, setPhase, setSnapshot]);
}

/**
 * Keeps the old picture until a current lease makes control usable. An
 * accepted handback gives control back at once, and the stage holds the
 * picture handed back until the stream paints a newer frame.
 */
export function useActivityTakeoverTransition(options: ActivityTransitionOptions) {
  const { requested, request, complete, settled, replaceViewer } = options;
  const [phase, setPhase] = useState<TakeoverPhase>(requested ? "claiming" : "agent");
  /** The picture of the handback in flight, sent again by a retry. */
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<BrowserPresentation | null>(null);
  const held = useHeldPicture(!requested && latest?.ready ? latest.displayed : null);
  const { hold, drop: dropHeld } = held;
  const releasedAfter = useRef<PaintedBrowserFrame | null>(null);
  const generation = useRef(0);
  const [epoch, setEpoch] = useState(0);
  const live = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useTransitionEffects({ settled, requested, phase, request, generation, dropHeld,
    setEpoch, setPhase, setSnapshot, setError });

  const start = useCallback(() => {
    if (phase !== "agent") return;
    generation.current += 1;
    setEpoch(generation.current);
    setSnapshot(null);
    dropHeld();
    setError(null);
    setPhase("claiming");
    complete.reset();
    request(true);
  }, [complete, dropHeld, phase, request]);
  const controlReady = useCallback(() => {
    setPhase((current) => current === "claiming" ? "controlling" : current);
  }, []);
  const controlLost = useCallback((reason: string) => {
    if (phaseRef.current !== "controlling") return;
    setError(reason);
    setPhase("error");
  }, []);
  const release = useCallback(() => {
    if (phase !== "controlling") return;
    generation.current += 1;
    setEpoch(generation.current);
    releasedAfter.current = latest?.displayed ?? null;
    setSnapshot(null);
    setError(null);
    complete.reset();
    setPhase("releasing");
  }, [complete, latest, phase]);
  const submit = useCallback(async (image: string) => {
    if (epoch !== generation.current) return;
    try { await complete.mutateAsync(); if (live.current && epoch === generation.current) {
      request(false);
      setPhase("agent");
      setSnapshot(null);
      hold(image, releasedAfter.current);
    } }
    catch (cause) {
      if (!live.current || epoch !== generation.current) return;
      const replacement = reopenedViewerUrl(cause);
      if (replacement) {
        replaceViewer(replacement);
        setSnapshot(null);
        setPhase("claiming");
        setError("Continue signing in, then hand control back.");
      } else {
        setPhase("error");
        setError(cause instanceof Error ? cause.message : "Handoff failed. Retry it.");
      }
    }
  }, [complete, epoch, hold, replaceViewer, request]);
  const frozen = useCallback((image: string | null) => {
    if (!live.current || phaseRef.current !== "releasing" || epoch !== generation.current) return;
    if (!image) {
      setError("The browser picture could not be saved. Retry the handoff.");
      setPhase("error");
      return;
    }
    setSnapshot(image);
    void submit(image);
  }, [epoch, submit]);
  const presentationChanged = useCallback((presentation: BrowserPresentation) => {
    setLatest(presentation);
  }, []);
  const retry = useCallback(() => {
    if (phase !== "error") return;
    setError(null);
    if (snapshot) { setPhase("releasing"); void submit(snapshot); return; }
    setPhase("claiming");
  }, [phase, snapshot, submit]);

  return { phase, snapshot: snapshot ?? held.picture, error, start, controlReady, controlLost, release, frozen,
    presentationChanged, retry };
}
