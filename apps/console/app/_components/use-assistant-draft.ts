"use client";

import { useCallback, useRef, useState } from "react";

import type { BrowserStreamMessage } from "./browser-viewport";

/**
 * The live draft of what the agent is typing right now, fed by the stream's
 * assistant_delta frames (each carries the accumulated tail, so frames are
 * idempotent and drop-tolerant). After `done` the finished text stays as the
 * draft until the persisted event catches up — the conversation suppresses
 * the duplicate by text, so the message never flickers out and back.
 *
 * `thinking` is the wordless half: a turn's opening frame says the model is
 * being called, and the first typed text or the message's done frame ends
 * it. It lives only on this socket — a reconnect learns it again at the next
 * turn — so the page gates it on a run that is actually live.
 */
export function useAssistantDraft(next: (message: BrowserStreamMessage) => boolean) {
  const [draft, setDraft] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const seqRef = useRef(0);
  const onStreamMessage = useCallback((message: BrowserStreamMessage): boolean => {
    if (message.type !== "assistant_delta") return next(message);
    const seq = typeof message.seq === "number" ? message.seq : 0;
    if (message.thinking === true) {
      setThinking(true);
      return true;
    }
    if (message.done === true) setThinking(false);
    if (typeof message.text !== "string") return true;
    // The done frame carries the message's FINAL text: taking it is what
    // guarantees the draft equals the persisted event, so the by-text
    // suppression always matches. A throttled delta can miss the tail.
    seqRef.current = seq;
    setThinking(false);
    setDraft(message.text);
    return true;
  }, [next]);
  return { draft, thinking, onStreamMessage };
}
