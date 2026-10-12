import type { RunEventView } from "@shipbash/contracts/api/view-types";

/**
 * Pure view logic for the Execution log column: artifact collapsing,
 * started/completed pairing, repeat noise reduction, and stick-to-bottom
 * scrolling. Kept free of React so every rule is unit-testable.
 */

export interface DisplayRunEvent extends RunEventView {
  artifactCount?: number | undefined;
}

export interface ExecutionLogRow {
  event: DisplayRunEvent;
  /** active = unclosed started (shimmer); paired = started+completed merged. */
  phase: "active" | "paired" | "plain";
  durationLabel: string | null;
  count: number;
}

/** Runtime jargon → the reader's vocabulary (journeys, checkpoints, verification). */
const SUMMARY_REWRITES: ReadonlyArray<[RegExp, string]> = [
  [/^Case started: (.+?)\.?$/u, "Journey started: $1"],
  [/^Case completed: (.+?)\.?$/u, "Journey completed: $1"],
  [/^Case verification goals updated\.?$/u, "Checkpoints updated"],
  [/^Suite execution (started|completed|canceled)\.?$/u, "Verification $1"],
  [/^Waiting for human authentication\.?$/u, "Waiting for you to sign in"],
  [/^Run results and retained evidence were finalized\.?$/u, "Results and evidence saved"],
];

/**
 * Log rows read as a user-facing feed, so runtime phrasing is translated and
 * normalized here: known jargon is rewritten, raw event-type fallbacks such as
 * "browser recording ready" get a capital, and single-sentence rows drop the
 * trailing period.
 */
function humanizeEventSummary(summary: string): string {
  let result = summary;
  for (const [pattern, replacement] of SUMMARY_REWRITES) {
    if (pattern.test(result)) {
      result = result.replace(pattern, replacement);
      break;
    }
  }
  if (/^[a-z]/u.test(result)) result = result.charAt(0).toUpperCase() + result.slice(1);
  if (result.endsWith(".") && !result.includes(". ")) result = result.slice(0, -1);
  return result;
}

function collapseArtifactEvents(events: readonly RunEventView[]): DisplayRunEvent[] {
  const collapsed: DisplayRunEvent[] = [];
  for (const rawEvent of events) {
    // Pointer telemetry drives the Agent cursor overlay, not the log.
    if (rawEvent.eventType === "agent_pointer") continue;
    // Console rows quote page output verbatim, so they are never rewritten.
    const event = rawEvent.kind === "console"
      ? { ...rawEvent }
      : { ...rawEvent, summary: humanizeEventSummary(rawEvent.summary) };
    const previous = collapsed.at(-1);
    if (event.eventType === "artifact_saved" && previous?.eventType === "artifact_saved") {
      const artifactCount = (previous.artifactCount ?? 1) + 1;
      collapsed[collapsed.length - 1] = {
        ...previous,
        summary: `${String(artifactCount)} artifacts saved`,
        timestamp: event.timestamp,
        artifacts: [...(previous.artifacts ?? []), ...(event.artifacts ?? [])],
        artifactCount,
      };
      continue;
    }
    collapsed.push({ ...event, artifactCount: event.eventType === "artifact_saved" ? 1 : undefined });
  }
  return collapsed;
}

const PAIRED_EVENT_TYPES: Record<string, { source: "agent" | "browser"; role: "started" | "completed" }> = {
  agent_action_started: { source: "agent", role: "started" },
  agent_action_completed: { source: "agent", role: "completed" },
  browser_command: { source: "browser", role: "started" },
  browser_result: { source: "browser", role: "completed" },
};

function formatActionDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 1_000 ? `${String(Math.round(ms))} ms` : `${(ms / 1_000).toFixed(1)}s`;
}

/** Browser result rows carry their duration as a "42 ms" detail string. */
function parseDurationDetail(detail: string | null | undefined): number | null {
  const match = /^(\d+)\s*ms$/u.exec(detail?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

function timestampDuration(started: string, completed: string): number | null {
  const from = new Date(started).getTime();
  const to = new Date(completed).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return to - from;
}

/** "Agent started browser.click" reads oddly once the action is done. */
function pairedAgentLabel(summary: string): string {
  const action = /^Agent started (.+?)\.?$/u.exec(summary)?.[1];
  return action === undefined ? summary : `Agent · ${action}`;
}

/**
 * What the surviving row says once a completed event closes its started one:
 * the started row keeps its identity, and the completion contributes the
 * finished phrasing, a level it raised, the end time, its own detail when that
 * detail is not the duration, and any artifacts it carried.
 *
 * A completion that raised the level also supplies the row's detail line: its
 * summary is the only place the reader is told what went wrong, and the
 * started row's own words describe an action that had not failed yet.
 */
function mergedPairedEvent(
  started: DisplayRunEvent,
  completed: DisplayRunEvent,
  source: "agent" | "browser",
  detailDuration: number | null,
): DisplayRunEvent {
  const raised = completed.level === "error" || completed.level === "warning";
  return {
    ...started,
    summary: source === "agent" ? pairedAgentLabel(started.summary) : started.summary,
    level: raised ? completed.level : started.level,
    timestamp: completed.timestamp,
    detail: raised
      ? completed.summary
      : completed.detail && detailDuration === null ? completed.detail : started.detail,
    artifacts: completed.artifacts?.length
      ? [...(started.artifacts ?? []), ...completed.artifacts]
      : started.artifacts,
  };
}

/**
 * Merges started/completed pairs into a single row. Events have no
 * correlation id, so an unclosed started matches the next completed from the
 * same source. Orphan starteds stay active (shimmer); orphan completeds
 * render as-is, except empty 0 ms completions, which are pure noise.
 */
function pairRunEvents(events: readonly DisplayRunEvent[]): ExecutionLogRow[] {
  const rows: ExecutionLogRow[] = [];
  const open: Partial<Record<"agent" | "browser", ExecutionLogRow | undefined>> = {};
  for (const event of events) {
    const pairing = PAIRED_EVENT_TYPES[event.eventType];
    if (pairing?.role === "started") {
      const row: ExecutionLogRow = { event, phase: "active", durationLabel: null, count: 1 };
      rows.push(row);
      open[pairing.source] = row;
      continue;
    }
    if (pairing?.role === "completed") {
      const started = open[pairing.source];
      const detailDuration = parseDurationDetail(event.detail);
      if (started) {
        open[pairing.source] = undefined;
        const durationMs = detailDuration
          ?? timestampDuration(started.event.timestamp, event.timestamp);
        started.phase = "paired";
        started.durationLabel = durationMs === null ? null : formatActionDuration(durationMs);
        started.event = mergedPairedEvent(started.event, event, pairing.source, detailDuration);
        continue;
      }
      if (detailDuration === 0) continue;
      rows.push({ event, phase: "plain", durationLabel: null, count: 1 });
      continue;
    }
    rows.push({ event, phase: "plain", durationLabel: null, count: 1 });
  }
  return rows;
}

/** Collapses consecutive same-name rows (launch/close loops) into one ×N row. */
function collapseRepeatedRows(rows: readonly ExecutionLogRow[]): ExecutionLogRow[] {
  const collapsed: ExecutionLogRow[] = [];
  for (const row of rows) {
    const previous = collapsed.at(-1);
    if (
      previous
      && previous.phase === row.phase
      && previous.event.summary === row.event.summary
      && (previous.event.level ?? "info") === (row.event.level ?? "info")
      && !previous.event.artifacts?.length
      && !row.event.artifacts?.length
    ) {
      collapsed[collapsed.length - 1] = {
        ...previous,
        count: previous.count + row.count,
        durationLabel: row.durationLabel ?? previous.durationLabel,
        event: { ...previous.event, timestamp: row.event.timestamp },
      };
      continue;
    }
    collapsed.push(row);
  }
  return collapsed;
}

export function buildExecutionLog(events: readonly RunEventView[]): ExecutionLogRow[] {
  return collapseRepeatedRows(pairRunEvents(collapseArtifactEvents(events)));
}

const STICK_TO_BOTTOM_THRESHOLD_PX = 48;

export function shouldStickToBottom(
  element: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">,
): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX;
}
