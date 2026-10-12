"use client";

import { useCallback, useEffect, useState } from "react";

import { newerFrame, type PaintedBrowserFrame } from "./browser-presentation";

/**
 * The picture an accepted handback leaves on the stage. `hold(image, after)`
 * keeps it until the stream paints a frame newer than `after`, the one on
 * screen when control was released; `drop()` lets it go at once. `painted` is
 * the frame the stream has painted for the agent, null while it has none.
 */
export function useHeldPicture(painted: PaintedBrowserFrame | null) {
  const [held, setHeld] = useState<{ image: string; after: PaintedBrowserFrame | null } | null>(null);
  useEffect(() => {
    if (held && painted && newerFrame(painted, held.after)) setHeld(null);
  }, [held, painted]);
  const hold = useCallback((image: string, after: PaintedBrowserFrame | null) => setHeld({ image, after }), []);
  const drop = useCallback(() => setHeld(null), []);
  return { picture: held?.image ?? null, hold, drop };
}
