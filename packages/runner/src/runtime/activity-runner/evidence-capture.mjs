import { agentActionSummary } from "../agent-actions.mjs";
import { NOT_RETAINED, startEvidenceRecorder } from "../evidence-recorder.mjs";
import { evidenceStop } from "../jev-stops.mjs";
import { OUTPUT_ROOT } from "./environment.mjs";
import { redactActivityValue } from "./redaction.mjs";
import { emit, getBrowserLifecycleFault, setBrowserLifecycleFault } from "./state.mjs";

// A runner process owns one Activity, and its sidecar keeps one port for the
// leg. The capture promise also queues actions that arrive while the
// recorder's connection to it is being established.
let recorder = null;
/** @type {Promise<true | import("../evidence-frames.mjs").StepMissing>} */
let pendingCapture = Promise.resolve(NOT_RETAINED);
export function startActivityEvidenceCapture(sidecar) {
  if (!sidecar || recorder) return;
  recorder = startEvidenceRecorder({ upstreamPort: sidecar.port, outputDirectory: OUTPUT_ROOT })
    .catch(() => null);
}

/**
 * A browser step failed on a browser silent past the bound: ShipBash's
 * browser has stopped answering. The Activity stops rather than hand it to
 * the agent again, whose every browser call would wait out its own timeout
 * on it; the fault ends those calls (child-process.mjs isLifecycleFaulted).
 * @param {number} silentMs
 */
function faultSilentBrowser(silentMs) {
  if (getBrowserLifecycleFault()) return;
  setBrowserLifecycleFault(`ShipBash's browser stopped answering: it had not answered for at least ${String(Math.floor(silentMs / 1_000))} s. `
    + "This is a ShipBash-side fault, not a finding about the product.");
  emit("warning", "ShipBash's browser stopped answering", {
    safeData: { event: "browser_unresponsive", category: "browser_lifecycle", silentMs },
  });
}

/** Every browser step, the agent's or Jev's; a step that failed on a silent browser faults the Activity. */
export function captureActivityStep(name, args, state) {
  const step = { tool: name, succeeded: state === "ok", observation: redactActivityValue(agentActionSummary(name, args)) };
  // No recorder keeps no picture: the same answer as a step whose picture was lost.
  pendingCapture = (recorder ?? Promise.resolve(null))
    .then((capture) => capture?.captureStep(step) ?? NOT_RETAINED)
    .then((captured) => {
      if (captured !== true && captured.reason === "browser_unresponsive") faultSilentBrowser(captured.silentMs);
      return captured;
    });
}

/** Stops the goal's walk at a step with no picture, for why it has none (the browser gone, silent, or the picture lost). */
export async function flushActivityStepCapture() {
  const captured = await pendingCapture;
  if (captured !== true) throw evidenceStop(captured);
}

export async function closeActivityEvidenceCapture() {
  const capture = await recorder;
  await capture?.close();
}
