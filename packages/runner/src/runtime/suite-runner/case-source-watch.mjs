/**
 * What the screencast sidecar says of the browser behind a Case's stream, as
 * the Case's own events. A lost connection and the same browser attached
 * again go on the record in pairs, the generation each started and the gap
 * between them. A browser found gone (its endpoint refused the attach) proves
 * the one the walk acted on no longer exists: the walk stops, reported once
 * however often the sidecar says so.
 */
import { emit } from "./state.mjs";

/** The reason a walk whose browser is gone aborts with, the event that says so, and the code runCase reports it by. */
export const BROWSER_GONE = "browser_gone";

/**
 * @param {{ abort: (reason: string) => void, signal: AbortSignal }} budget the walk's
 * @param {Record<string, unknown>} context the case identity events carry
 */
export function caseSourceWatch(budget, context) {
  return {
    onSourceLost: ({ generation, cause }) => emit("browser", "browser_stream_lost", {
      ...context, generation, cause,
      message: "The live browser stream lost its connection; it is attaching again to the same browser.",
    }),
    onSourceRestored: ({ generation, gapMs, cause }) => emit("browser", "browser_stream_reattached", {
      ...context, generation, gapMs, cause,
      message: `The live browser stream attached again to the same browser after ${String(gapMs)} ms.`,
    }),
    onBrowserGone: ({ cause }) => {
      if (budget.signal.aborted) return;
      emit("browser", BROWSER_GONE, {
        ...context, cause,
        message: "The browser this journey was walking is gone; the walk stops here.",
      });
      budget.abort(BROWSER_GONE);
    },
  };
}
