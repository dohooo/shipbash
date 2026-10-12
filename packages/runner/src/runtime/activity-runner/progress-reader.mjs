// The Activity progress channel: validates every event the shipbash_progress
// MCP server writes (agent output, narratives, journeys, human-auth
// requests, discovery events, the Journey marks a recorded walk cuts its
// video to) and republishes each one as the Activity event it becomes.
import { rejectUnknownKeys, requiredString } from "@shipbash/contracts/runtime/contract-values.mjs";
import {
  NARRATIVE_LABELS,
  structuredResultLikeText,
} from "@shipbash/contracts/runtime/activity-lifecycle-projection.mjs";
import { discoveryEventEmission, parseDiscoveryProgressEvent } from "../discovery-events.mjs";
import { createJsonlRevisionReader, parseRevisionEnvelope } from "../jsonl-progress-reader.mjs";
import { JOURNEY_EDGES, JOURNEY_TITLE_LIMIT, NARRATIVE_KINDS } from "../progress-tools.mjs";

import { redactString } from "./redaction.mjs";
import { emit, noteAuthCandidatePending } from "./state.mjs";

/** One edge of a Journey the walk marked; the walk's recording places it where the runner reads it (recording-capture.mjs). */
function parseJourneyMark(value) {
  rejectUnknownKeys(value, new Set(["schemaVersion", "revision", "event", "edge", "title"]), "activityProgress");
  const edge = requiredString(value.edge, "activityProgress.edge", 5);
  if (!JOURNEY_EDGES.includes(edge)) throw new Error("Activity progress channel emitted an unsupported Journey edge.");
  const title = redactString(requiredString(value.title, "activityProgress.title", JOURNEY_TITLE_LIMIT), JOURNEY_TITLE_LIMIT);
  return { event: "journey_mark", edge, title };
}

export function parseActivityProgressEvent(line, expectedRevision = 1) {
  const value = parseRevisionEnvelope(line, expectedRevision, "Activity progress channel");
  const event = requiredString(value.event, "activityProgress.event", 32);
  if (event === "agent_output") {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "markdown"]),
      "activityProgress",
    );
    return {
      event,
      markdown: redactString(
        requiredString(value.markdown, "activityProgress.markdown", 20_000),
        20_000,
      ),
    };
  }
  if (event === "agent_narrative") {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "kind", "text", "screenshot"]),
      "activityProgress",
    );
    const kind = requiredString(value.kind, "activityProgress.kind", 20);
    if (!NARRATIVE_KINDS.includes(kind)) {
      throw new Error("Activity progress channel emitted an unsupported narrative kind.");
    }
    if (value.screenshot !== undefined && typeof value.screenshot !== "boolean") {
      throw new Error("activityProgress.screenshot must be a boolean.");
    }
    return {
      event,
      kind,
      text: redactString(requiredString(value.text, "activityProgress.text", 200), 200),
      screenshot: value.screenshot === true,
    };
  }
  if (event === "human_auth_request") {
    rejectUnknownKeys(
      value,
      new Set(["schemaVersion", "revision", "event", "reason"]),
      "activityProgress",
    );
    return {
      event,
      reason: redactString(requiredString(value.reason, "activityProgress.reason", 500), 500),
    };
  }
  if (event === "journey_mark") return parseJourneyMark(value);
  const discovery = parseDiscoveryProgressEvent(event, value, redactString);
  if (discovery) return discovery;
  throw new Error("Activity progress channel emitted an unsupported event.");
}


/**
 * The knowledge/auth agent_action row for one progress event, or null. These
 * two toolClasses are emitted HERE and nowhere else: only the progress
 * channel carries the entry's title and the sign-in reason (the CLI stream
 * names the tool but never its arguments), so the lifecycle projection keeps
 * its legacy events for these tools. The calls are local file appends, so
 * `ms` is honestly zero; the console renders it as a dash.
 */
export function progressAgentAction(update) {
  const row = update.event === "knowledge_entry"
    ? { label: `Knowledge · ${update.kind}`, toolClass: "knowledge", verb: update.kind, target: update.title }
    : update.event === "human_auth_request"
      ? { label: "Auth · ask", toolClass: "auth", verb: "ask", target: update.reason }
      : null;
  if (!row) return null;
  return {
    label: row.label,
    safeData: {
      event: "agent_action",
      toolClass: row.toolClass,
      verb: row.verb,
      target: row.target.slice(0, 60),
      ms: 0,
      state: "ok",
      milestoneId: null,
    },
  };
}

export async function startActivityProgressReader(eventPath, onUpdate, options = {}) {
  const captureScreenshot = options.captureScreenshot ?? (async () => null);
  return createJsonlRevisionReader(eventPath, {
    channelName: "Activity progress channel",
    onLine: async (line, nextRevision) => {
      const update = parseActivityProgressEvent(line, nextRevision);
      // A filed sign-in request means the login state may change in place on
      // this browser: arm candidate retention for an authenticated result.
      if (update.event === "human_auth_request") noteAuthCandidatePending(update.reason);
      await onUpdate(update);
      if (update.event === "agent_output") {
        // The structured final result must never surface as a user-facing
        // progress message; it is delivered through the parsed result path.
        if (!structuredResultLikeText(update.markdown)) {
          emit("lifecycle", "ShipBash update", {
            bodyMarkdown: update.markdown,
            safeData: { event: "agent_output", phase: "progress" },
          });
        }
      } else if (update.event === "agent_narrative") {
        const screenshotDataUrl = update.screenshot
          ? await captureScreenshot(update).catch(() => null)
          : null;
        emit("lifecycle", NARRATIVE_LABELS[update.kind], {
          bodyMarkdown: update.text,
          safeData: {
            event: "agent_narrative",
            phase: "progress",
            narrativeKind: update.kind,
            screenshot: update.screenshot,
            ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
          },
        });
            } else {
        const carried = discoveryEventEmission(update);
        if (carried) emit(carried.kind, carried.label, carried.payload);
      }
      const action = progressAgentAction(update);
      if (action) emit("tool_summary", action.label, { safeData: action.safeData });
    },
  });
}
