// The terminal-conclusion gate. A run that
// declares itself stuck is reconciled against the last page it actually saw:
// when that snapshot still shows an obvious way forward — a Continue, a Next,
// a Submit — the declaration is contradicted by the agent's own eyes, and the
// harness says so out loud instead of letting the report stand unchallenged.
import { readFile, writeFile } from "node:fs/promises";

// Written by the agent-browser MCP proxy on every appended observation, read
// here at terminal time. Both processes share the container's work directory.
export const LAST_SNAPSHOT_PATH = "/shipbash/work/last-snapshot.txt";

// A control line in an accessibility snapshot whose accessible name reads as
// a way forward. Matches the snapshot's own row shape (a role followed by a
// quoted name) so page prose that merely mentions "continue" cannot trigger
// the gate, and `[disabled]` rows are excluded before the name is examined.
const CONTINUATION_CONTROL_PATTERN =
  /\b(?:button|link|menuitem|tab)\b(?:(?!\[disabled\])[^\n"])*"[^"\n]*\b(?:continue|next|submit|skip|get started|install|sign in|log in|proceed|create|connect)\b[^"\n]*"/iu;

/**
 * The way forward the last snapshot still showed, or null when the snapshot
 * genuinely offered none (or was never captured). Returns the matched row so
 * the warning can quote the agent's own evidence back at it.
 */
export function continuationShownIn(snapshotText) {
  if (typeof snapshotText !== "string" || !snapshotText.trim()) return null;
  const match = CONTINUATION_CONTROL_PATTERN.exec(snapshotText);
  return match ? match[0].trim().slice(0, 200) : null;
}

/**
 * Reconcile a stuck declaration against the retained last snapshot. Reading
 * nothing is a clean pass — a run that never opened a page has no snapshot
 * and nothing to contradict.
 */
export async function prematureStopEvidence(snapshotPath = LAST_SNAPSHOT_PATH) {
  let snapshot;
  try {
    snapshot = await readFile(snapshotPath, "utf8");
  } catch {
    return null;
  }
  return continuationShownIn(snapshot);
}

/**
 * The ready-to-emit warning for a needs_attention result, or null when the
 * last page genuinely offered no way forward. The wording quotes the agent's
 * own evidence back at it, for the owner.
 */
export async function prematureStopWarning(snapshotPath = LAST_SNAPSHOT_PATH) {
  const wayForward = await prematureStopEvidence(snapshotPath);
  if (!wayForward) return null;
  return {
    bodyMarkdown: `ShipBash stopped needing attention, but the last page it saw still showed a way forward: \`${wayForward}\`. Review whether this run gave up at a door rather than a wall.`,
    safeData: { event: "conclusion_contradicted", control: wayForward },
  };
}

/**
 * The gate's hook: reconcile a needs_attention result against the retained last
 * snapshot and emit the warning through the caller's channel. Any other
 * status passes untouched — the gate judges stuck declarations only.
 */
export async function emitPrematureStopWarning(result, emit, snapshotPath = LAST_SNAPSHOT_PATH) {
  if (result?.status !== "needs_attention") return;
  const warning = await prematureStopWarning(snapshotPath);
  if (warning) emit("warning", "The stop may be premature", warning);
}

/**
 * The settled page for a held action arrived: merge and release the action.
 * `snapshotText` is the settled reading (page-settle.mjs), so what the agent
 * reads as "the page after this action" is the page the action produced; its
 * URL, `observation.url`, rides the block's first line, where the walk record
 * reads where the action left the walk (suite-runner/walk-record.mjs).
 */
export function mergeObservation(observation, snapshotText, harnessGuidance, snapshotLimit) {
  const held = observation.held;
  if (snapshotText) {
    // The gate's evidence: the full, untruncated last page state, retained
    // for the terminal-conclusion reconciliation (conclusion-gate.mjs).
    void writeFile(LAST_SNAPSHOT_PATH, `${snapshotText}\n`, { mode: 0o600 }).catch(() => {});
    const bounded = snapshotText.length > snapshotLimit
      ? `${snapshotText.slice(0, snapshotLimit)}\n…[snapshot truncated — call agent_browser_snapshot for the full tree]`
      : snapshotText;
    held.result.content.push({
      type: "text",
      text: `[ShipBash harness] Page after this action:${observation.url ? ` ${observation.url}` : ""}\n${bounded}`,
    });
    held.result.content.push(...harnessGuidance(snapshotText).map((text) => ({ type: "text", text })));
    if (typeof observation.veilNote === "string" && observation.veilNote) {
      held.result.content.push({ type: "text", text: observation.veilNote });
    }
    if (typeof observation.waitingNote === "string" && observation.waitingNote) {
      held.result.content.push({ type: "text", text: observation.waitingNote });
    }
  }
  return JSON.stringify(held);
}

