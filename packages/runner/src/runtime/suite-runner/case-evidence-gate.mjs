// The evidence gate of a case's walk (case-agent.mjs): every browser step keeps its picture, or the walk stops.
import { evidenceStop } from "../jev-stops.mjs";
import { BROWSER_SOURCE, piLifecycleProjector } from "./agent-lifecycle.mjs";

/** The event that waits for the last step's picture: before a verdict and when the walk is over (jev-verification.mjs settle). */
export const JEV_SETTLE_PICTURE = "jev_settle_picture";

// Browser reads that leave the screen as it is: the page's URL without the cursor aimed, its snapshot or text.
const STILL_READS = new Set(["agent_browser_snapshot", "agent_browser_get_text", "agent_browser_read"]);

/** Whether a browser call can change what the screen shows, and so must not run while a picture is taken. */
function movesScreen(event) {
  if (event.toolName === "agent_browser_get_url") return Boolean(event.args?.aim);
  return !STILL_READS.has(event.toolName);
}

/** The reason a walk whose browser stopped answering aborts with (caseEvidenceGate). */
export const BROWSER_UNRESPONSIVE = "browser_unresponsive";

/**
 * Jev acts and judges only while the harness is recording the walk. Its
 * checkpoint verdicts are made from a text snapshot, and the step screenshots
 * retained beside them are the evidence the owner sees for each one. A Jev
 * step whose picture was not retained stops the walk before its next input or
 * verdict, for why it has none
 * (evidence-frames.mjs): the recording lost it, and the supervising agent
 * continues the attempt; the browser is gone, and the sidecar's watch has
 * already stopped the attempt (case-source-watch.mjs); or the step failed on
 * a browser silent past the bound. That last one stops the attempt whoever
 * took the step, Jev or the supervising agent: ShipBash's browser has stopped
 * answering, and no agent is left to wait on it.
 * @param {Record<string, unknown>} context the case identity events carry
 * @param {{ abort: (reason: string) => void, signal: AbortSignal }} budget the walk's
 * @param {(completion: object) => Promise<true | import("../evidence-frames.mjs").StepMissing> | undefined} onToolCompleted
 *   the lane's capture of a completed tool: a browser step's answer, or nothing for any other tool
 */
export function caseEvidenceGate(context, budget, onToolCompleted) {
  /** @type {{ silentMs: number } | null} */
  let silence = null;
  const capture = (completion) => {
    const captured = onToolCompleted(completion);
    void captured?.then((missing) => {
      if (missing === true || missing.reason !== BROWSER_UNRESPONSIVE || budget.signal.aborted) return;
      silence = missing;
      budget.abort(BROWSER_UNRESPONSIVE);
    });
    return captured;
  };
  return {
    capture,
    /** How long the browser had not answered when a step stopped the attempt for it. */
    silentMs: () => silence?.silentMs ?? 0,
    /**
     * Jev's tool events, projected as its own agent's: a browser step without
     * its picture stops the walk. The picture is taken while the walk reads
     * the next page and Jev chooses, which change nothing on screen; the walk
     * waits for it before its next call that can (an input, a reload, the
     * cursor aimed at a target), before its next verdict, and at its end — the
     * last two through JEV_SETTLE_PICTURE (jev-verification.mjs settle).
     */
    jevToolEvents(sources) {
      let captured;
      let pending = null;
      const lifecycle = piLifecycleProjector(context, sources, (completion) => { captured = capture(completion); });
      const settle = async () => {
        const missing = await pending;
        pending = null;
        if (missing !== true) throw evidenceStop(missing);
      };
      return async (event) => {
        if (pending && (event.type === JEV_SETTLE_PICTURE || (event.type === "tool_execution_start" && movesScreen(event)))) await settle();
        if (event.type === JEV_SETTLE_PICTURE) return;
        captured = undefined;
        lifecycle(event);
        if (event.type === "tool_execution_end" && sources.get(event.toolName) === BROWSER_SOURCE) pending = captured;
        else await captured;
      };
    },
  };
}
