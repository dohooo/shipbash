/**
 * What the harness knows about the control mount, read for the pi session
 * and the browser proxy: the user's mid-run steer files, the wrap-up
 * sentinel, and what we already know about the page the agent just opened.
 *
 * The agent has no tool for any of it. That is deliberate — a lookup it has
 * to decide to perform is a lookup it mostly will not. Steers and the
 * wrap-up reach the agent as messages through session.steer() (pi-agent-slot,
 * pi-wrap-up); page notes ride along on the tool results it is already
 * reading, exactly once — re-served on every navigation they would bury the
 * page actually being read.
 */
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { normalizePageKey } from "@shipbash/contracts/runtime/page-key.mjs";

export { normalizePageKey };

// A pending steer is `NNNN.json`; the pi session consumes it once (unlink)
// and folds it through session.steer().
const STEER_FILE_PATTERN = /^\d{14}-[0-9a-f]{12}\.json$/u;

/** The control-mount layout, mirroring runtime/knowledge-tools.mjs. */
export function harnessPathsUnder(controlRoot) {
  const root = typeof controlRoot === "string" ? controlRoot.trim().replace(/\/+$/u, "") : "";
  if (!root) return { wrapUpPath: "", pageIndexPath: "", steerDirectory: "" };
  return {
    wrapUpPath: `${root}/wrapup`,
    pageIndexPath: `${root}/knowledge/page-index.json`,
    steerDirectory: `${root}/steer`,
  };
}

/** Every http(s) URL appearing in a tool result's text blocks. */
export function urlsInToolResult(result) {
  const found = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (typeof block?.text !== "string") continue;
    for (const match of block.text.matchAll(/https?:\/\/[^\s"'`<>)\]}]+/giu)) {
      found.push(match[0]);
    }
  }
  return found;
}

/**
 * Takes every pending steer instruction, oldest first (the zero-padded names
 * sort), consuming each file exactly once: the delete happens before the
 * message is used, so a steer is delivered at most once even if injection
 * fails midway. For delivery paths that must acknowledge only AFTER a
 * successful hand-off, use peekPendingSteers + consumePendingSteer instead.
 */
export function takePendingSteers(directory) {
  return peekPendingSteers(directory).map((steer) => {
    consumePendingSteer(steer.path);
    return { message: steer.message, clientKey: steer.clientKey, images: steer.images };
  });
}

/**
 * The images a steer file carries, as pi takes them with a prompt: what the
 * leg's opening fetched for it (control-plane agent-data/steer-images.ts).
 * @param {unknown} value
 * @returns {Array<{ type: "image", data: string, mimeType: string }>}
 */
function steerImages(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((image) => isRecord(image) && image.type === "image"
    && typeof image.data === "string" && image.data !== "" && typeof image.mimeType === "string")
    .map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

/**
 * Reads every pending steer without consuming any, oldest first. Each entry
 * keeps its file path so the caller can consume exactly the ones it actually
 * delivered — the seam that lets an acknowledgement be true.
 */
export function peekPendingSteers(directory) {
  if (!directory) return [];
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const steers = [];
  for (const name of names.filter((entry) => STEER_FILE_PATTERN.test(entry)).sort()) {
    const path = `${directory}/${name}`;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Malformed or half-written: consume it so it can never wedge the pump.
      consumePendingSteer(path);
      continue;
    }
    if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message.trim()) {
      steers.push({
        path,
        message: parsed.message,
        clientKey: typeof parsed.clientKey === "string" ? parsed.clientKey : "",
        images: steerImages(parsed.images),
      });
    } else {
      consumePendingSteer(path);
    }
  }
  return steers;
}

/** Removes one steer file after its message has truly been handed over. */
export function consumePendingSteer(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone — consumption is idempotent.
  }
}

/**
 * Appends the page's knowledge to one tool result, strictly once per page:
 * re-serving the same page on every navigation would crowd out the page the
 * agent is actually looking at. `servedPageKeys` carries that memory across
 * calls. Steers and the wrap-up do not ride tool results — the pi session
 * delivers both through session.steer().
 */
export function appendHarnessNotes(result, { pageIndex, servedPageKeys }) {
  if (!Array.isArray(result?.content) || !pageIndex) return false;
  let changed = false;
  for (const url of urlsInToolResult(result)) {
    const key = normalizePageKey(url);
    if (!key || servedPageKeys.has(key)) continue;
    const entries = pageIndex.get(key);
    servedPageKeys.add(key);
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const lines = entries.map((entry) => `- [${entry.id}] ${entry.kind}: ${entry.line}`);
    result.content.push({
      type: "text",
      text: `\n\nKnowledge for this page:\n${lines.join("\n")}`,
    });
    changed = true;
  }
  return changed;
}

/** The host's page-key → entries map, or null when this run has none. */
/** True when the user has asked this run to stop and deliver. */
export function wrapUpRequested(path) {
  return Boolean(path) && existsSync(path);
}

export function readPageIndex(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return null;
    const index = new Map();
    for (const [key, entries] of Object.entries(parsed)) {
      if (Array.isArray(entries) && entries.length > 0) index.set(key, entries);
    }
    return index.size > 0 ? index : null;
  } catch {
    // Page notes are an enhancement; a malformed index must never stop the run.
    return null;
  }
}
