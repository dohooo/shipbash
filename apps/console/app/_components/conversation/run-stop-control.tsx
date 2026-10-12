"use client";

import { Square } from "lucide-react";
import { useState } from "react";

interface RunStopControlProps {
  state: "idle" | "stopping";
  onStop: () => void;
  /** Why the last stop request was refused, shown beside the restored button. */
  error?: string | null;
}

/**
 * Stop asks its one question in place, in the footer where the button already
 * is: idle → "Keep exploring / Stop" → stopping. The two answers are the whole
 * question, so no sentence precedes them. Stopping is one action, and what
 * the run already walked is kept. Stopping holds until the
 * run itself ends: the button stays where it was, disabled and busy, so the
 * footer keeps its height and a second click cannot land.
 */
export function RunStopControl({ state, onStop, error = null }: RunStopControlProps) {
  const [confirming, setConfirming] = useState(false);

  if (state === "stopping") {
    return (
      <div className="conv-stop" data-state="stopping">
        <button className="button conv-stop-trigger" type="button" disabled aria-busy="true">
          <Square aria-hidden="true" />
          Stopping…
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="conv-stop" data-state="confirm">
        <button className="button quiet" type="button" onClick={() => { setConfirming(false); }}>
          Keep exploring
        </button>
        <button className="button danger" type="button" onClick={() => { setConfirming(false); onStop(); }}>
          Stop
        </button>
      </div>
    );
  }

  return (
    <div className="conv-stop" data-state="idle">
      {error ? <span className="inline-error" role="alert">{error}</span> : null}
      <button
        className="button conv-stop-trigger"
        type="button"
        onClick={() => { setConfirming(true); }}
      >
        <Square aria-hidden="true" />
        Stop
      </button>
    </div>
  );
}
