import type { RunEventView } from "@shipbash/contracts/api/view-types";

import type { BrowserStreamMessage } from "./browser-viewport";
import { eventTimestamp, redact } from "./live-run-stream";

/**
 * The browser gateway's messages, read into the shapes the run page keeps:
 * the address and title it mirrors, the page viewport it reports, and the
 * execution-log rows its commands, results and console lines become.
 */

/**
 * The tab the gateway marked current. Every element shape a JSON list can
 * hold has to survive the scan, so this admits any object whose `active` is
 * exactly true and turns away everything else.
 */
function isActiveTab(candidate: unknown): candidate is Record<string, unknown> {
  return candidate !== null
    && typeof candidate === "object"
    && Reflect.get(candidate, "active") === true;
}

interface BrowserPageRevision {
  /** The address to show, or null to keep the one already there. */
  address: string | null;
  /** The title to show, or null to keep the one already there. */
  title: string | null;
}

const KEEP: BrowserPageRevision = { address: null, title: null };

export function browserPageRevision(message: BrowserStreamMessage): BrowserPageRevision {
  if (message.type === "url") {
    return { address: typeof message.url === "string" ? message.url : null, title: null };
  }
  if (message.type !== "tabs" || !Array.isArray(message.tabs)) return KEEP;
  const activeTab = message.tabs.find(isActiveTab);
  return {
    address: typeof activeTab?.url === "string" ? activeTab.url : null,
    title: typeof activeTab?.title === "string" && activeTab.title.trim() ? activeTab.title : null,
  };
}

/** The page's own CSS viewport, when the status message states a usable one. */
export function streamViewportSize(
  message: BrowserStreamMessage,
): { width: number; height: number } | null {
  const width = Number(message.viewportWidth);
  const height = Number(message.viewportHeight);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function commandEvent(message: BrowserStreamMessage): RunEventView {
  return {
    id: "",
    eventType: "browser_command",
    kind: "action",
    summary: `Browser · ${redact(message.action ?? "action")}`,
    timestamp: eventTimestamp(message.timestamp),
  };
}

function resultEvent(message: BrowserStreamMessage): RunEventView {
  const failed = Boolean(message.error) || (message.success === false && message.data == null);
  return {
    id: "",
    eventType: "browser_result",
    kind: "result",
    level: failed ? "error" : "info",
    summary: failed ? "Browser action failed" : "Browser action completed",
    detail: message.duration_ms == null ? "" : `${String(message.duration_ms)} ms`,
    timestamp: eventTimestamp(message.timestamp),
  };
}

function consoleEvent(message: BrowserStreamMessage): RunEventView {
  return {
    id: "",
    eventType: "browser_console",
    kind: "console",
    level: message.level === "error"
      ? "error"
      : message.level === "warning" || message.level === "warn"
        ? "warning"
        : "info",
    summary: `Console · ${redact(message.text)}`,
    timestamp: eventTimestamp(message.timestamp),
  };
}

/** The execution-log row this message becomes, or null when it becomes none. */
export function browserLogEvent(message: BrowserStreamMessage): RunEventView | null {
  if (message.type === "command") return commandEvent(message);
  if (message.type === "result") return resultEvent(message);
  if (message.type === "console") return consoleEvent(message);
  return null;
}
