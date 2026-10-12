/**
 * The one deliberate semantic exception in the agent-browser MCP proxy:
 * wait_for_text normalizes whitespace so it matches what the snapshot shows.
 *
 * The daemon's text wait is a raw `innerText.includes(text)`, while the
 * snapshot renders accessible names with whitespace collapsed and invisible
 * characters deleted — a heading wrapped by a literal newline never matches
 * the one-line text the agent copied from the snapshot (a 15s wall, then a
 * false congestion note). The proxy forwards wait_for_text as a
 * wait_for_function whose expression matches the raw substring OR the
 * snapshot-normalized one OR the same with NBSP read as a space, so
 * everything the daemon matched still matches.
 */
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

const WAIT_FOR_TEXT_TOOL = "agent_browser_wait_for_text";
const WAIT_FOR_FUNCTION_TOOL = "agent_browser_wait_for_function";
// The arguments a text wait shares with the function wait it becomes; `text`
// itself is folded into the expression, nothing else is forwarded.
const WAIT_FOR_TEXT_PASSTHROUGH = ["waitTimeoutMs", "timeoutMs", "session", "namespace", "idleTimeout"];

const TEXT_WAIT_NOTE = "[ShipBash harness] Text waits match the page's text; to wait for a "
  + "redirect, use agent_browser_wait_for_url on the destination.";

// What the snapshot does to a name before the agent reads it: the invisible
// characters agent-browser's snapshot drops outright (NBSP, zero-width
// space/joiners, word joiner, BOM), then runs of whitespace collapsed to one
// space. The page text gets the same treatment so the two can meet. A second
// reading keeps NBSP as the space a reader sees, so "Sign in" typed with a
// plain space still finds a page that renders "Sign in".
const INVISIBLE_CHARS_SOURCE = "[\\u00a0\\u200b\\u200c\\u200d\\u2060\\ufeff]";
const ZERO_WIDTH_CHARS_SOURCE = "[\\u200b\\u200c\\u200d\\u2060\\ufeff]";
const INVISIBLE_CHARS = new RegExp(INVISIBLE_CHARS_SOURCE, "gu");
const ZERO_WIDTH_CHARS = new RegExp(ZERO_WIDTH_CHARS_SOURCE, "gu");

function collapse(text, dropped) {
  return text.replace(dropped, "").replace(/\s+/gu, " ").trim();
}

/** The text as the snapshot would show it. */
function normalizeWhitespace(text) {
  return collapse(text, INVISIBLE_CHARS);
}

/**
 * The expression a text wait becomes: the daemon's own raw match
 * (`innerText.includes(text)`) OR the same match with the snapshot's
 * normalization applied to both sides OR with NBSP read as a space. All
 * literals are JSON-encoded, so the text can never escape the expression.
 */
export function waitForTextExpression(text) {
  const raw = JSON.stringify(text);
  const shown = JSON.stringify(collapse(text, INVISIBLE_CHARS));
  const spaced = JSON.stringify(collapse(text, ZERO_WIDTH_CHARS));
  const page = (dropped) => `t.replace(/${dropped}/g, "").replace(/\\s+/g, " ")`;
  return `((t) => t.includes(${raw}) || ${page(INVISIBLE_CHARS_SOURCE)}.includes(${shown})`
    + ` || ${page(ZERO_WIDTH_CHARS_SOURCE)}.includes(${spaced}))`
    + "(document.body ? document.body.innerText || \"\" : \"\")";
}

/**
 * Forwards a wait_for_text call as the wait_for_function it is equivalent
 * to; every other request passes through with a null `textWait`. The result
 * comes back through `restoreTextWaitResult`, so the agent sees the text
 * wait it called.
 */
export function rewriteWaitForText(request) {
  const untouched = { request, textWait: null };
  if (request?.method !== "tools/call" || !isRecord(request.params)) return untouched;
  if (request.params.name !== WAIT_FOR_TEXT_TOOL) return untouched;
  const args = isRecord(request.params.arguments) ? request.params.arguments : {};
  if (typeof args.text !== "string" || !args.text) return untouched; // The daemon owns the schema error.
  // Whitespace-only text would collapse to "" and match every page; the
  // daemon's raw semantics keep that call honest.
  if (!normalizeWhitespace(args.text)) return untouched;
  const forwarded = { expression: waitForTextExpression(args.text) };
  for (const key of WAIT_FOR_TEXT_PASSTHROUGH) {
    if (args[key] !== undefined) forwarded[key] = args[key];
  }
  return {
    request: { ...request, params: { ...request.params, name: WAIT_FOR_FUNCTION_TOOL, arguments: forwarded } },
    textWait: { text: args.text },
  };
}

/**
 * Gives a rewritten text wait back its own face: a success echoes the text
 * the way the daemon's wait_for_text does; a timeout keeps the daemon's words
 * and adds the one lesson a text wall teaches.
 */
export function restoreTextWaitResult(response, textWait) {
  if (response.result.isError === true) {
    // Only a wall earns the lesson; a browser that is not even up does not.
    const first = response.result.content[0];
    if (isRecord(first) && typeof first.text === "string" && first.text.startsWith("Wait timed out")) {
      response.result.content.push({ type: "text", text: TEXT_WAIT_NOTE });
    }
    return;
  }
  response.result.content = [{ type: "text", text: textWait.text }];
}
