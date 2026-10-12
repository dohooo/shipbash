"use client";

/**
 * "Hand off to agent", wherever a settled walk offers it — the run report's
 * cover, a Journey's walk history and the Activity page's bar: one press
 * copies the prompt that sends a coding agent to the walk's evidence.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * A copy button says nothing until it has been pressed, so the mark carries
 * the answer: Copy, swapped for Check the moment the text is on the clipboard
 * and back again once the reader has had time to see it.
 */
function CopyMark() {
  return (
    <span className="rp-copy-mark">
      <svg className="rp-ic-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <svg className="rp-ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

const COPIED_MS = 1_800;

/** Whether the last press reached the clipboard, and for how long it says so. */
function useCopied(): [boolean, (done: boolean) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [copied, (done: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    setCopied(done);
    if (done) timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }];
}

/**
 * The button. Primary on the cover, where it is the one thing to do; secondary
 * where the page's own decision is elsewhere.
 */
export function HandoffButton({ onCopy, primary = false }: {
  onCopy: () => Promise<boolean>;
  primary?: boolean;
}) {
  const [copied, setCopied] = useCopied();
  const [failed, setFailed] = useState(false);
  const copy = () => {
    void onCopy().then((done) => { setCopied(done); setFailed(!done); });
  };
  return (
    <div className="rp-split rp-split-sm" data-copied={copied ? "true" : undefined}>
      {/* A plain button, never an ActionButton: a press replayed after the
          page's code runs would write to the clipboard outside the press. */}
      <button className={primary ? "button primary rp-split-main" : "button rp-split-main"} type="button" onClick={copy}>
        Hand off to agent
        <span className="rp-split-ic" aria-hidden="true"><CopyMark /></span>
      </button>
      <p className="rp-copy-status" role="status">{failed ? "The prompt could not reach the clipboard" : ""}</p>
    </div>
  );
}

/** Reports a copy that did or did not reach the clipboard. */
export function reproCopied(promise: Promise<void>): Promise<boolean> {
  return promise.then(
    () => {
      toast.success("Prompt copied", {
        description: "Paste it to your local coding agent; it starts from this walk's evidence.",
      });
      return true;
    },
    () => {
      toast.error("The prompt could not reach the clipboard");
      return false;
    },
  );
}
