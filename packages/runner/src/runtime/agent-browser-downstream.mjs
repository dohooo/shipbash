/**
 * The proxy's downstream half: every rewrite that happens on the way back
 * from `agent-browser mcp` to the agent. Split from agent-browser-mcp-proxy.mjs
 * by direction — the proxy owns the outbound request path and the process
 * plumbing, this owns what a response says by the time the agent reads it.
 *
 * tools/list responses are de-paginated: agent-browser 0.33+ pages its
 * catalogue past 64 tools, and a client that never follows the cursor is left
 * with zero browser tools, so the proxy walks the pages itself (via
 * `followCursor`) and answers the client with one merged, filtered page. A
 * tool result carries back harness notes, a text wait's own face, the note
 * naming arguments the harness dropped, and the slow-call note; a screenshot
 * travels as a link to the file it was saved to. A mutating action's result is held while the page it
 * produced settles, then released with that page merged in; a snapshot is
 * held while the proxy learns which requests sent since the last action still
 * have no answer.
 * Unparsable lines,
 * and responses to requests this proxy never forwarded, pass through
 * untouched.
 */
import { basename, extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { OFFERED_TOOLS, withoutRefusedArguments } from "./agent-browser-catalogue.mjs";
import { callArgumentNote, withoutHarnessOwnedSchema } from "./agent-browser-arg-policy.mjs";
import { OBSERVE_ID_PREFIX } from "./agent-browser-observation.mjs";
import { POINTER_BOX_ID_PREFIX } from "./agent-pointer.mjs";
import { appendHarnessNotes } from "./harness-notes.mjs";
import { decorateToolDescriptions } from "./tool-craft.mjs";
import { REACH_ID_PREFIX } from "./reachability.mjs";
import { requestedWaitBudgetMs } from "./agent-browser-wait-budget.mjs";
import { restoreTextWaitResult } from "./agent-browser-text-wait.mjs";
import { SHOWN_PIXELS } from "./screenshot-image.mjs";

// A tools/call slower than this gets an explanatory note appended to its
// result. Chosen well below the CLI's 30s stall plateau so the first slow
// call already tells the agent what is happening.
const SLOW_CALL_NOTE_MS = 10_000;
// Every state-changing action gets the settled page appended to its result,
// so "look" stops costing the agent a model round of its own. The proxy holds
// the action's response and hands it to the observer
// (agent-browser-observation.mjs), which releases it once the page it
// produced has stopped changing. Each is also the action whose requests the
// observer names while they wait.
export const OBSERVED_TOOLS = new Set([
  "agent_browser_click",
  "agent_browser_dblclick",
  "agent_browser_fill",
  "agent_browser_type",
  "agent_browser_check",
  "agent_browser_uncheck",
  "agent_browser_select",
  // These three change the page as surely as a click and used to come back
  // blind, so the agent spent a whole round asking for the snapshot it should
  // have been handed: one Discovery walked click → press → snapshot → click
  // for ten rounds. A scroll's new viewport is a page change too, and its
  // snapshot is bounded by the same limit as every other one below.
  "agent_browser_press",
  "agent_browser_back",
  "agent_browser_scroll",
  // Jev's executor reloads to verify persistence and judges the next reading
  // it takes, so the reloaded page is settled here like any other action's.
  "agent_browser_reload",
  // Moving between pages and tabs changes the page in front as surely: the
  // result says which page that is, URL included, where a supervisor walk
  // used to close a side tab and judge the tab left in front without looking
  // at it.
  "agent_browser_forward",
  "agent_browser_tab_switch",
  "agent_browser_tab_close",
  // A URL loaded in the current tab ends where its redirects do; the page
  // that came back names it.
  "agent_browser_open",
]);

/** The elapsed time and actual result, without inferring browser liveness. */
function slowCallNote(elapsedMs, failed) {
  const seconds = Math.round(elapsedMs / 1_000);
  return `[ShipBash harness] This browser call took ${String(seconds)}s to return. `
    + (failed
      ? "The call returned an error; its duration does not establish whether the browser is healthy."
      : "The call returned successfully; its duration does not establish whether the browser is healthy.");
}

/** The parsed response this proxy may rewrite, or null to pass the raw line through. */
function proxiedResponse(line) {
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    return null;
  }
  // Only responses to requests this proxy forwarded are rewritten; server-
  // initiated requests carry a method and keep their own id space.
  return isRecord(response) && response.id !== undefined && response.method === undefined
    ? response
    : null;
}

/**
 * A proxy-owned id whose pending entry timed out already (snapshot or box):
 * swallow the late reply instead of leaking a synthetic id.
 */
function swallowLateProxyReply(id) {
  return typeof id === "string"
    && (id.startsWith(OBSERVE_ID_PREFIX)
      || id.startsWith(POINTER_BOX_ID_PREFIX)
      || id.startsWith(REACH_ID_PREFIX))
    ? ""
    : null;
}

/** One merged, filtered catalogue page, or "" while more pages are still being walked. */
function rewriteToolsList(response, pending, followCursor) {
  const tools = response.result?.tools;
  if (!Array.isArray(tools)) return null;
  const collected = [...(pending.tools ?? []), ...tools];
  const cursor = response.result.nextCursor;
  if (typeof cursor === "string" && cursor && followCursor) {
    followCursor(pending, collected, cursor);
    return "";
  }
  // Refused arguments go before the craft is appended, so a lesson rides the
  // restated description instead of being replaced with the one it restates.
  response.result.tools = decorateToolDescriptions(collected.filter((tool) => OFFERED_TOOLS.has(tool?.name))
    .map(withoutRefusedArguments)).map(withoutHarnessOwnedSchema);
  delete response.result.nextCursor;
  if (pending.clientId !== undefined) response.id = pending.clientId;
  return JSON.stringify(response);
}

/**
 * Everything a tool result carries back besides its own content: harness
 * notes, a text wait's own face, and the slow-call note. Returns whether the
 * response changed at all.
 */
function annotateToolResult(response, pending, harness, now) {
  // A text wait's own face first: it replaces the daemon's block, and every
  // note below must land on top of it, never under it (a page's knowledge
  // is served exactly once — swallowing it here would lose it for good).
  const restored = isRecord(pending.textWait);
  if (restored) restoreTextWaitResult(response, pending.textWait);
  // Harness notes ride on any tool result the agent reads; the URL in a
  // navigation or observation result is what selects the page's knowledge.
  const noted = harness
    ? appendHarnessNotes(response.result, {
        pageIndex: harness.pageIndex,
        servedPageKeys: harness.servedPageKeys,
      })
    : false;
  // A call whose arguments the harness dropped or rewrote learns what changed.
  const stripped = Array.isArray(pending.droppedArgs) && pending.droppedArgs.length > 0;
  if (stripped) response.result.content.push({ type: "text", text: callArgumentNote(pending.droppedArgs) });
  const elapsed = now - pending.at;
  // Only the time beyond the agent's own wait budget can be congestion.
  const excess = elapsed - requestedWaitBudgetMs(pending.name, pending.callArgs);
  const slow = SLOW_CALL_NOTE_MS > 0 && excess >= SLOW_CALL_NOTE_MS;
  if (slow) response.result.content.push({
    type: "text",
    text: slowCallNote(elapsed, response.result.isError === true || response.result.structuredContent?.response?.success === false),
  });
  return noted || restored || stripped || slow;
}

const SCREENSHOT_TOOL = "agent_browser_screenshot";
/** The image type of a saved screenshot, by its file's extension. */
const SCREENSHOT_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"]]);
/** What a full page's result says of the part the model is shown (screenshot-image.mjs). */
const FULL_PAGE_NOTE = `[Only the top ${String(SHOWN_PIXELS)} px of this full-page screenshot are shown; scroll and take viewport screenshots for the rest.]`;

/**
 * The file the daemon says it saved the screenshot to, in the field its own
 * CLI reads (`data.path`), when that is an absolute PNG or JPEG path; else null.
 */
function savedScreenshotPath(result) {
  const data = result.structuredContent?.response?.data;
  const path = isRecord(data) ? data.path : undefined;
  return typeof path === "string" && isAbsolute(path) && SCREENSHOT_TYPES.has(extname(path).toLowerCase()) ? path : null;
}

/**
 * A screenshot travels as a link to the file it was saved to, never inline.
 * The daemon inlines only a small one, and a full page's base64 can outgrow
 * the one line the runner's MCP client reads (16 MiB); the runner attaches a
 * scaled-down copy of the file (browser-mcp.mjs), and a full page's result
 * says that only its top is shown. Returns whether the result changed.
 */
function linkScreenshotFile(result, callArgs) {
  const content = result.content.filter((part) => part?.type !== "image");
  const path = savedScreenshotPath(result);
  if (!path) {
    const dropped = content.length !== result.content.length;
    result.content = content;
    return dropped;
  }
  const note = callArgs?.fullPage === true ? [{ type: "text", text: FULL_PAGE_NOTE }] : [];
  const mimeType = SCREENSHOT_TYPES.get(extname(path).toLowerCase());
  result.content = [...content, ...note, { type: "resource_link", uri: pathToFileURL(path).href, name: basename(path), mimeType }];
  return true;
}

/**
 * An annotated tools/call result, or "" while the observer holds it: an
 * action's until its page settles, a snapshot's while it learns which of the
 * requests sent since the last action still have no answer.
 */
function rewriteToolCall(response, pending, harness, now, observer) {
  if (pending.method !== "tools/call" || !Array.isArray(response.result?.content)) return null;
  const linked = pending.name === SCREENSHOT_TOOL && response.result.isError !== true && linkScreenshotFile(response.result, pending.callArgs);
  const annotated = annotateToolResult(response, pending, harness, now) || linked;
  if (observer && response.result?.isError !== true) {
    if (OBSERVED_TOOLS.has(pending.name)) {
      observer.observe(pending, response);
      return "";
    }
    if (pending.name === "agent_browser_snapshot" && observer.annotating()) {
      observer.annotate(pending, response);
      return "";
    }
  }
  return annotated ? JSON.stringify(response) : null;
}

function routeToolResponse(response, pending, now, harness, observer) {
  // A proxy-owned read — observation, pointer box, reachability probe — is
  // reclaimed by whoever asked for it and never reaches the agent.
  if (pending.kind === "observe" || pending.kind === "box" || pending.kind === "reach") {
    pending.deliver?.(response);
    return "";
  }
  return rewriteToolCall(response, pending, harness, now, observer);
}

/**
 * Rewrites one downstream response the proxy is interested in, or returns
 * null to pass the raw line through untouched.
 * @param {{ observe: Function, annotate: Function, annotating: () => boolean } | null} [observer] the proxy's observer (agent-browser-observation.mjs)
 */
export function rewriteDownstreamLine(
  line,
  pendingRequests,
  now = Date.now(),
  followCursor = null,
  harness = null,
  observer = null,
) {
  const response = proxiedResponse(line);
  if (!response) return null;
  const pending = pendingRequests.get(response.id);
  if (!pending) return swallowLateProxyReply(response.id);
  pendingRequests.delete(response.id);
  if (pending.method === "tools/list") return rewriteToolsList(response, pending, followCursor);
  return routeToolResponse(response, pending, now, harness, observer);
}
