/**
 * What the screencast sidecar says of the browser behind an Activity's
 * stream, as the Activity's own events. A lost connection and the same
 * browser attached again go on the record in pairs, the generation each
 * started and the gap between them. A browser found gone (its endpoint
 * refused the attach) proves the one this Activity drove no longer exists:
 * the agent stops rather than go on in another browser. The browser call in
 * flight is the one on the wire when the connection was lost, not when the
 * refusal came back.
 */
import { emit, inflightBrowserCall, setBrowserLifecycleFault } from "./state.mjs";

/** @param {string} runtimeInstance */
export function activitySourceWatch(runtimeInstance) {
  let lostWhile = null;
  return {
    onSourceLost: ({ generation, cause }) => {
      const inflight = inflightBrowserCall.current;
      lostWhile = inflight ? { tool: inflight.name, ms: Date.now() - inflight.at } : null;
      emit("evidence", "Live browser connection lost", {
        safeData: {
          event: "browser_stream_lost", runtimeInstance, generation, cause,
          inflightTool: lostWhile?.tool ?? null, inflightMs: lostWhile?.ms ?? null,
        },
      });
    },
    onSourceRestored: ({ generation, gapMs, cause }) => emit("evidence", "Live browser attached again", {
      safeData: { event: "browser_stream_reattached", runtimeInstance, generation, gapMs, cause },
    }),
    onBrowserGone: ({ cause }) => {
      setBrowserLifecycleFault("The browser this Activity was driving is gone.");
      emit("warning", "The browser this Activity was driving is gone", {
        ...(lostWhile ? { bodyMarkdown: `While \`${lostWhile.tool}\` had been on the wire for ${String(lostWhile.ms)}ms.` } : {}),
        safeData: {
          event: "browser_gone", runtimeInstance, category: "browser_lifecycle", cause,
          inflightTool: lostWhile?.tool ?? null, inflightMs: lostWhile?.ms ?? null,
        },
      });
    },
  };
}
