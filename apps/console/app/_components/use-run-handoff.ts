"use client";

import type { UseMutationResult } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { completeVerificationAuth } from "../../lib/run-control-client";
import { reopenedViewerUrl } from "../_lib/request-errors";
import { setHandback } from "./handback-intent";
import type { useNoVncControl } from "./use-novnc-control";

type Phase = "claiming" | "controlling" | "releasing" | "error";
type HandbackRequest = UseMutationResult<Awaited<ReturnType<typeof completeVerificationAuth>>, Error, void>;

/**
 * Once the API accepts the handback, the reader goes back to the run at once:
 * the run page shows the picture handed back until the resumed run paints. A
 * run the service could not resume is still waiting on its sign-in, so it
 * goes back without the handback's picture and green banner.
 */
export function useRunHandoff({ runId, viewer, viewerUrl, handback, markHandoff, restartTakeover, navigate }: {
  runId: string;
  viewer: ReturnType<typeof useNoVncControl>;
  viewerUrl: string | null;
  handback: HandbackRequest;
  markHandoff: () => void;
  /** Asks for the takeover again, the way opening the page did. */
  restartTakeover: () => void;
  navigate: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("claiming");
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const viewerRetrying = useRef(false);
  const cycle = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: viewerUrl invalidates an in-flight freeze when its lease changes.
  useLayoutEffect(() => {
    cycle.current += 1;
    return () => { cycle.current += 1; };
  }, [viewerUrl]);
  // A changed viewer lease resets the handoff even though the effect only writes state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: viewerUrl is the viewer identity reset key.
  useEffect(() => { setPhase("claiming"); }, [viewerUrl]);
  useEffect(() => {
    if (viewerRetrying.current && !viewer.error) viewerRetrying.current = false;
    if (viewer.enabled && phase === "claiming") {
      setPhase("controlling");
      setSnapshot(null);
      setLocalError(null);
    }
    if (!viewer.enabled && phase === "controlling") setPhase(viewer.error ? "error" : "claiming");
    if (viewer.error && !viewerRetrying.current && phase === "claiming") setPhase("error");
  }, [phase, viewer.enabled, viewer.error]);
  useEffect(() => {
    if (handback.isError && !reopenedViewerUrl(handback.error)) setPhase("error");
  }, [handback.error, handback.isError]);

  const release = async () => {
    if (phase !== "controlling") return;
    const activeCycle = cycle.current;
    setPhase("releasing");
    markHandoff();
    const image = await viewer.freeze();
    if (cycle.current !== activeCycle) return;
    if (!image) {
      setLocalError("The browser picture could not be saved. Retry the handoff.");
      setPhase("error");
      return;
    }
    setSnapshot(image);
    handback.mutate(undefined, {
      onSuccess: ({ resumed }) => {
        if (resumed) setHandback(runId, image);
        navigate();
      },
    });
  };
  const retry = () => {
    setLocalError(null);
    // A failed save that reopened no viewer may have ended the handoff, and
    // its browser with it: Retry asks for the takeover again, which answers
    // with the browser still open or a fresh one.
    if (handback.isError && !reopenedViewerUrl(handback.error)) {
      handback.reset();
      restartTakeover();
    }
    viewerRetrying.current = true;
    viewer.restart();
    setPhase("claiming");
  };
  const cancel = () => { cycle.current += 1; navigate(); };
  return { phase, snapshot, localError, release, retry, cancel };
}
