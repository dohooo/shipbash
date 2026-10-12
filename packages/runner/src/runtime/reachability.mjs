// The reachability gate's pure half: the page-side verdict script and the
// refusal wording. A QA agent may only do what a real user could do — so an
// action whose target another element would receive is refused with that
// element named (Selenium's wording, Playwright's hit test), one whose target
// takes up no space is refused as not visible (Playwright's actionability
// check), and a visual veil over the target earns a warning even though hit
// testing passes straight through it.
// Alignment sources: injectedScript.ts (Playwright), atoms.js (Selenium);
// browser-use's detect-then-pierce fallback is deliberately not reproduced.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

/** The action noun a refusal names, from the tool that attempted it. */
export function actionNoun(toolName) {
  const name = typeof toolName === "string" ? toolName.replace(/^agent_browser_/u, "") : "";
  if (name === "fill" || name === "type") return "input";
  if (name === "check" || name === "uncheck" || name === "select") return "change";
  return "click";
}

/**
 * The page-side verdict script. Runs where the page runs, returns a plain
 * JSON object (the eval envelope adds its own wrapping — no double
 * encoding): { verdict: "reachable" | "intercepted" | "scrimmed",
 * blocker: string | null }.
 */
export function reachabilitySource(box) {
  const x = Number(box?.x);
  const y = Number(box?.y);
  const width = Number(box?.width);
  const height = Number(box?.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error("reachabilitySource needs a finite, positive target box.");
  }
  // The script is self-contained: no references to outer scope, target
  // identity carried purely as geometry.
  return `(() => {
  const box = { x: ${String(x)}, y: ${String(y)}, width: ${String(width)}, height: ${String(height)} };
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const describe = (el) => {
    if (!el || !el.tagName) return "an element";
    const id = el.id ? '#' + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return "<" + el.tagName.toLowerCase() + id + cls + ">";
  };
  const within = (rect) => (
    rect.left >= box.x - 2 && rect.top >= box.y - 2
    && rect.right <= box.x + box.width + 2 && rect.bottom <= box.y + box.height + 2
  );
  const hits = document.elementsFromPoint(cx, cy);
  let hit = hits[0] ?? null;
  // display:contents elements are missed by elementsFromPoint (crbug
  // 1342092); the singular API sees them.
  if (!hit) hit = document.elementFromPoint(cx, cy);
  if (!hit) return { verdict: "reachable", blocker: null };
  // Walk the composed tree up looking for a hit whose own footprint lives
  // inside the target box — the target itself or one of its descendants.
  let cursor = hit;
  let inside = false;
  while (cursor && cursor !== document.documentElement) {
    if (within(cursor.getBoundingClientRect())) { inside = true; break; }
    cursor = cursor.assignedSlot ?? cursor.parentElement;
  }
  if (!inside) return { verdict: "intercepted", blocker: describe(hits[0] ?? hit) };
  // Hit testing passed; look for a visual veil it ignores —
  // pointer-events:none paint covering the click point.
  for (const el of document.querySelectorAll("*")) {
    const rect = el.getBoundingClientRect();
    if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue;
    if (within(rect)) continue;
    const style = getComputedStyle(el);
    if (style.pointerEvents !== "none") continue;
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (!(parseFloat(style.opacity) > 0.05)) continue;
    const match = /rgba?\\(([^)]+)\\)/.exec(style.backgroundColor);
    const parts = match ? match[1].split(",") : null;
    const alpha = parts ? (parts[3] === undefined ? 1 : parseFloat(parts[3])) : 0;
    if (alpha < 0.05) continue;
    return { verdict: "scrimmed", blocker: describe(el) };
  }
  return { verdict: "reachable", blocker: null };
})()`;
}

/**
 * Reads the eval envelope back into a verdict. Anything unrecognizable is
 * null — the gate fails open on its own confusion, never on the page's.
 */
export function reachabilityVerdict(value) {
  const unwrapped = verdictCandidate(value);
  if (typeof unwrapped !== "object" || unwrapped === null) return null;
  const verdict = unwrapped.verdict;
  if (verdict !== "reachable" && verdict !== "intercepted" && verdict !== "scrimmed") return null;
  return {
    verdict,
    blocker: typeof unwrapped.blocker === "string" && unwrapped.blocker ? unwrapped.blocker : null,
  };
}

// The verdict object sits wherever the transport put it: bare, under the CLI's
// data wrapping, or under the daemon's result.data.
function verdictCandidate(value) {
  if (value?.verdict !== undefined) return value;
  return value?.data?.result ?? value?.data ?? value?.result?.data ?? value;
}

/** The refusal for an action another element would receive. */
export function reachabilityRefusal(toolName, blocker) {
  const covering = blocker ?? "another element";
  return `${covering} would receive this ${actionNoun(toolName)} — a real user cannot reach the target. `
    + "Deal with the covering layer first: dismiss it or interact with it; "
    + "if it is a configuration choice, ask the owner (rule 4).";
}

/**
 * The refusal for a target that takes up no space on the page — display:none,
 * or collapsed to nothing. Playwright's actionability check calls it "not
 * visible" and waits; the daemon would act at the page's corner and report
 * success.
 */
export function invisibleTargetRefusal(toolName) {
  return `The target of this ${actionNoun(toolName)} is not visible: it takes up no space on the page, `
    + "so a real user cannot see or reach it. Act on what the page shows instead — its visible label, "
    + "or the control that reveals it.";
}

/** The warning for a visual veil hit testing passes through. */
export function reachabilityVeilNote(blocker) {
  return `[ShipBash harness] ${blocker ?? "A translucent layer"} is painted over this element's click point `
    + "(pointer-events: none). A real user sees it covering the page — interact with the layer first, "
    + "or confirm it is purely decorative before continuing (rules 2 and 6).";
}

// Interaction verbs that turn eval from an eye into a hand. Reading
// handlers ("getAttribute('onclick')") stays free; invoking them does not.
export const EVAL_INTERACTION_PATTERN = /\.click\s*\(|\.submit\s*\(|dispatchEvent\s*\(/u;

/** Whether a tools/call carries eval code that interacts instead of reads. */
export function evalInteractionAttempt(request) {
  if (request?.method !== "tools/call") return false;
  const params = request.params;
  if (typeof params !== "object" || params === null) return false;
  if (params.name !== "agent_browser_eval") return false;
  const args = typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {};
  return Object.values(args).some((value) => typeof value === "string" && EVAL_INTERACTION_PATTERN.test(value));
}

export const EVAL_INTERACTION_REFUSAL =
  "eval was rejected: it invokes page handlers (.click/.submit/dispatchEvent), which bypasses the "
  + "realism checks a real user's actions go through. Use the real interaction tools instead; "
  + "eval is for reading the page.";

export const REACH_ID_PREFIX = "__shipbash_reach_";
export const REACH_TIMEOUT_MS = 1_500;

/**
 * A proxy-owned reachability probe over the daemon pipe, cut to the same
 * pattern as the pointer-box resolver: synthetic id, pending entry the
 * downstream rewriter delivers to, a timeout that resolves null so the gate
 * fails open, and idempotent settlement. `write` receives a newline-
 * terminated JSON-RPC line.
 */
export function createReachabilityProbe(write, pendingRequests) {
  let counter = 0;
  return function probeReachability(source, { session, namespace } = {}) {
    counter += 1;
    const id = `${REACH_ID_PREFIX}${String(counter)}`;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        pendingRequests.delete(id);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), REACH_TIMEOUT_MS);
      timer.unref?.();
      pendingRequests.set(id, {
        method: "tools/call",
        kind: "reach",
        at: Date.now(),
        deliver: (response) => finish(reachabilityVerdict(evalEnvelope(response))),
      });
      const args = { script: source };
      if (typeof session === "string" && session) args.session = session;
      if (typeof namespace === "string" && namespace) args.namespace = namespace;
      try {
        write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "agent_browser_eval", arguments: args } })}\n`);
      } catch {
        finish(null);
      }
    });
  };
}

/**
 * Unwraps an MCP eval response into the script's return value, or null.
 * The text content IS the script's return (agent-browser 0.33 daemon puts
 * lifecycle metadata, not the value, under structuredContent.response.data),
 * so text parses first and the structured envelope is only a fallback.
 */
export function evalEnvelope(response) {
  const result = response?.result;
  if (typeof result !== "object" || result === null || result.isError === true) return null;
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((entry) => entry?.type === "text")
      .map((entry) => entry.text)
      .join("\n")
      .trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch {
        // Fall through to the structured envelope.
      }
    }
  }
  const structured = result.structuredContent?.response;
  return typeof structured === "object" && structured !== null ? structured : null;
}

// The reachability gate covers every tool that mutates the page through an
// element: a real user cannot click, type into, or toggle what another
// element covers. All are OBSERVED_TOOLS, so a veil warning can ride the
// observation merge.
export const GATED_TOOLS = new Set([
  "agent_browser_click",
  "agent_browser_dblclick",
  "agent_browser_fill",
  "agent_browser_type",
  "agent_browser_check",
  "agent_browser_uncheck",
  "agent_browser_select",
]);

/** Unwraps a pointer-box envelope into a finite rect, or null. */
function boxFromEnvelope(envelope) {
  const data = envelope?.data ?? envelope?.result?.data ?? envelope;
  if (typeof data !== "object" || data === null) return null;
  const box = { x: data.x, y: data.y, width: data.width, height: data.height };
  return [box.x, box.y, box.width, box.height].every(Number.isFinite) ? box : null;
}

/** Maps a probe verdict onto the gate's answer for one tool call. */
function gateOutcome(name, verdict, box) {
  if (verdict?.verdict === "intercepted") {
    return { refusal: reachabilityRefusal(name, verdict.blocker) };
  }
  if (verdict?.verdict === "scrimmed") {
    return { box, veilNote: reachabilityVeilNote(verdict.blocker) };
  }
  return { box };
}

export async function gateReachability(request, resolveBox, probeReachability) {
  try {
    if (request?.method !== "tools/call" || !isRecord(request.params)) return null;
    const name = request.params.name;
    if (!GATED_TOOLS.has(name)) return null;
    const args = isRecord(request.params.arguments) ? request.params.arguments : {};
    const selector = typeof args.selector === "string" ? args.selector.trim() : "";
    if (!selector) return null;
    const session = typeof args.session === "string" ? args.session : "";
    const namespace = typeof args.namespace === "string" ? args.namespace : "";
    // No box at all is the resolver's own failure, and the gate fails open on
    // it; a box with no area is the page's answer.
    const box = boxFromEnvelope(await resolveBox({ selector, session, namespace }));
    if (!box) return null;
    if (box.width <= 0 || box.height <= 0) return { refusal: invisibleTargetRefusal(name) };
    const verdict = await probeReachability(reachabilitySource(box), { session, namespace });
    return gateOutcome(name, verdict, box);
  } catch {
    return null;
  }
}

