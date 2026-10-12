/**
 * MCP middleman between the agent runtime and `agent-browser mcp`. Five
 * deterministic responsibilities, none altering tool semantics: (1) cursor
 * lead — resolve a click's target box FIRST and publish the pointer before
 * forwarding, so the viewer's cursor arrives before the effect; a caller that
 * already knows its target can name it with `aim` on an earlier call, and the
 * cursor leaves then, so its flight overlaps that call instead of delaying
 * the action, and the action's own pointer (the one that pulses) lands with
 * the action; (2) tool
 * surface — lifecycle verbs are refused, the browser's launch and state
 * arguments are erased from calls and schemas (agent-browser-arg-policy), every
 * tool outside the harness's one catalogue is hidden, and eval may read
 * but not interact; (3) reachability — a gated action a real user could not
 * perform is refused with the covering element named, or as not visible when
 * its target takes up no space, and a visual veil earns a warning; (4)
 * slow-call notes — a call that ran at least 10s beyond the wait the agent
 * itself asked for gets one factual block so latency does not read as death
 * (a wait tool spending its own budget is never "slow"); (5) page-triggered
 * context — page knowledge, the settled page an action produced, and the
 * requests sent since it that still have no answer ride along on results the
 * agent already reads.
 * One deliberate semantic exception: (6) wait_for_text normalizes whitespace
 * so it matches what the snapshot shows — the why and the how live in
 * agent-browser-text-wait.mjs; the proxy only forwards and restores.
 * Action telemetry is not the proxy's: the pi tool wrapper sees every
 * call's name, args, duration and outcome in-process and emits the
 * browser-class agent_action events itself (pi-tooling.mjs).
 * Cursor and gate work is best-effort and time-bounded; unparsable lines
 * pass through untouched.
 */
import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { blockedToolResponse, refusalFor } from "./agent-browser-catalogue.mjs";
import { policeCallArguments } from "./agent-browser-arg-policy.mjs";
import {
  AGENT_POINTER_TOOLS,
  agentPointerFromBoundingBox,
  createPointerBoxResolver,
} from "./agent-pointer.mjs";
import { harnessPathsUnder, readPageIndex } from "./harness-notes.mjs";
import { createReachabilityProbe, gateReachability } from "./reachability.mjs";
import { rewriteWaitForText } from "./agent-browser-text-wait.mjs";
import { OBSERVED_TOOLS, rewriteDownstreamLine } from "./agent-browser-downstream.mjs";
import { createObservationRequester } from "./agent-browser-observation.mjs";

const POINTER_CHANNEL = process.env.SHIPBASH_POINTER_CHANNEL?.trim() || "";
// How long the forwarded action waits after the pointer is published, giving
// the viewer's cursor time to fly to the target BEFORE the click's effect
// appears in the screencast. Presentation pacing, deliberately small.
const POINTER_LEAD_MS = 200;
// How long an aim may wait for its action before the cursor is treated as
// parked: past this the next action flies the cursor again from scratch.
const AIM_MAX_AGE_MS = 5_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Seeded with wall-clock time so sequence numbers stay monotonic across a
// runtime (and therefore proxy) restart within the same task.
let pointerSequence = Date.now();
// The target a caller said it was about to act on, and when the cursor left
// for it. One at a time: calls are forwarded in order.
let aimed = null;

async function publishPointer(action, box) {
  if (!POINTER_CHANNEL) return false;
  const pointer = agentPointerFromBoundingBox(action, box);
  if (!pointer) return false;
  pointerSequence += 1;
  const line = JSON.stringify({
    event: "agent_pointer",
    seq: pointerSequence,
    action: pointer.action,
    x: pointer.x,
    y: pointer.y,
    width: pointer.width,
    height: pointer.height,
    // Source timestamp: every relay hop logs its age against this.
    at: Date.now(),
  });
  await appendFile(POINTER_CHANNEL, `${line}\n`, { mode: 0o600 }).catch(() => {});
  return true;
}

/** Resolves the target box and publishes the cursor before the action runs. */
function pointerTarget(request) {
  if (request?.method !== "tools/call" || !isRecord(request.params)) return null;
  const action = AGENT_POINTER_TOOLS.get(request.params.name);
  if (!action) return null;
  const args = isRecord(request.params.arguments) ? request.params.arguments : {};
  const selector = typeof args.selector === "string" ? args.selector.trim() : "";
  if (!selector) return null;
  return {
    action,
    selector,
    session: typeof args.session === "string" ? args.session : "",
    namespace: typeof args.namespace === "string" ? args.namespace : "",
  };
}

/**
 * The harness-owned `aim` argument: the element the caller is about to act on,
 * named on a call it has to make anyway. Removed from the call, because the
 * daemon knows nothing about it.
 */
function takeAim(request) {
  if (request?.method !== "tools/call" || !isRecord(request.params)) return null;
  const args = request.params.arguments;
  if (!isRecord(args) || typeof args.aim !== "string" || !args.aim.trim()) return null;
  const selector = args.aim.trim();
  delete args.aim;
  return {
    selector,
    session: typeof args.session === "string" ? args.session : "",
    namespace: typeof args.namespace === "string" ? args.namespace : "",
  };
}

/** Sends the cursor to the named target now, so its flight overlaps the caller's own work. */
async function aimCursor({ selector, session, namespace }, resolveBox) {
  try {
    const box = await resolveBox({ selector, session, namespace });
    // A move, not an act: the viewer sees the cursor travel, and nothing
    // pulses until the action itself lands.
    if (box && await publishPointer("hover", box)) aimed = { selector, at: Date.now() };
  } catch {
    // Presentation only.
  }
}

/** When the cursor left for this target, or null when nothing aimed it there. */
function departedFor(selector) {
  const departure = aimed?.selector === selector ? aimed.at : null;
  aimed = null;
  return departure !== null && Date.now() - departure <= AIM_MAX_AGE_MS ? departure : null;
}

async function leadCursor(request, resolveBox, preresolved = null) {
  try {
    const target = pointerTarget(request);
    if (!target) return;
    const { action, selector, session, namespace } = target;
    const box = preresolved ?? await resolveBox({ selector, session, namespace });
    if (!box) return;
    const departure = departedFor(selector);
    if (departure === null) {
      // Nothing aimed this target, so the cursor leaves now and the action
      // holds until it arrives.
      if (await publishPointer(action, box) && POINTER_LEAD_MS > 0) await delay(POINTER_LEAD_MS);
      return;
    }
    // The cursor has been flying since the target was named: hold only what is
    // left of that flight, then mark the action where the cursor lands.
    const remaining = POINTER_LEAD_MS - (Date.now() - departure);
    if (remaining > 0) await delay(remaining);
    await publishPointer(action, box);
  } catch {
    // Presentation only: never let cursor work disturb the forwarded action.
  }
}

/**
 * Reads the request log just before an observed action goes to the daemon:
 * the requests the log gains from here until the action's page settles are
 * the action's own (action-requests.mjs). The read runs while the cursor
 * flies to the target, so the action waits for whichever takes longer.
 */
async function readLogBefore(request, pendingRequests, observer) {
  const entry = isRecord(request) && request.id !== undefined ? pendingRequests.get(request.id) : undefined;
  if (entry?.method !== "tools/call") return;
  if (OBSERVED_TOOLS.has(entry.name)) entry.logBefore = await observer.logBefore(entry.callArgs);
  else await observer.openLog(entry.callArgs);
}

/**
 * Refuses, gates and rewrites one client request before it is forwarded.
 * Returns null when the request was answered here instead — a refusal is
 * already on stdout and nothing may reach the daemon.
 */
async function prepareRequest(request, options) {
  const { resolveBox, probeReachability, pendingRequests, droppedArgs } = options;
  // A refused call still shows as started in the CLI stream, so its
  // failed agent_action must close the row like any other outcome.
  const refuse = (message) => {
    process.stdout.write(`${blockedToolResponse(request.id, message)}\n`);
  };
  const refusal = refusalFor(request);
  if (refusal) {
    refuse(refusal);
    return null;
  }
  const gate = await gateReachability(request, resolveBox, probeReachability);
  if (gate?.refusal) {
    refuse(gate.refusal);
    return null;
  }
  // After the catalogue check: the agent may call wait_for_text, never
  // the wait_for_function it is forwarded as.
  const forwarded = rewriteWaitForText(request);
  pendingRequests.set(
    forwarded.request.id,
    pendingEntryFor(forwarded.request, gate, forwarded.textWait, droppedArgs),
  );
  return { request: forwarded.request, gate };
}

/** The pending-map entry for a forwarded request. */
function pendingEntryFor(request, gate, textWait = null, droppedArgs = []) {
  return {
    method: request.method,
    at: Date.now(),
    ...(request.method === "tools/list" ? { clientId: request.id } : {}),
    ...(request.method === "tools/call" && isRecord(request.params)
      ? {
          name: request.params.name,
          callArgs: isRecord(request.params.arguments) ? request.params.arguments : {},
        }
      : {}),
    ...(gate?.veilNote ? { veilNote: gate.veilNote } : {}),
    ...(textWait ? { textWait } : {}),
    ...(droppedArgs.length > 0 ? { droppedArgs } : {}),
  };
}

async function main() {
  // Every call joins the harness's browser (harness-browser.mjs). Without it
  // agent-browser would launch a browser of its own, one no stream, recorder
  // or sign-in is attached to: the proxy does not start.
  if (!process.env.AGENT_BROWSER_CDP) {
    process.stderr.write("[shipbash-mcp-proxy] AGENT_BROWSER_CDP is not set; agent-browser must join the harness's browser, never launch one.\n");
    process.exit(1);
  }
  // The daemon keeps the full surface (the proxy's synthetic calls need it);
  // the harness's catalogue applies to what the agent sees and sends.
  const child = spawn("agent-browser", ["mcp", "--tools", "all"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.on("exit", (code, signal) => {
    process.exit(typeof code === "number" ? code : signal ? 1 : 0);
  });

  // id → { method, at, clientId?, tools? } for requests forwarded downstream.
  const pendingRequests = new Map();
  let pageRequestCounter = 0;
  const followCursor = (pending, tools, cursor) => {
    pageRequestCounter += 1;
    const id = `__shipbash_tools_page_${String(pageRequestCounter)}`;
    pendingRequests.set(id, { ...pending, tools });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { cursor } })}\n`);
  };
  const harnessPaths = harnessPathsUnder(process.env.SHIPBASH_CONTROL_ROOT);
  const harness = {
    pageIndex: readPageIndex(harnessPaths.pageIndexPath),
    servedPageKeys: new Set(),
  };
  const resolveBox = createPointerBoxResolver((line) => child.stdin.write(line), pendingRequests);
  const probeReachability = createReachabilityProbe((line) => child.stdin.write(line), pendingRequests);
  const observer = createObservationRequester(
    (line) => child.stdin.write(line),
    pendingRequests,
    (line) => process.stdout.write(`${line}\n`),
  );
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on("line", (line) => {
    const rewritten = rewriteDownstreamLine(line, pendingRequests, Date.now(), followCursor, harness, observer);
    // An empty rewrite means the proxy is still walking catalogue pages.
    if (rewritten === "") return;
    process.stdout.write(`${rewritten ?? line}\n`);
  });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  input.on("line", (line) => {
    // Serialize so a call is never forwarded ahead of an earlier one while its
    // cursor box is still resolving; the runtime issues tool calls sequentially.
    chain = chain.then(async () => {
      let request = null;
      if (line.trim()) {
        try { request = JSON.parse(line); } catch { request = null; }
      }
      let gate = null;
      // Before anything else: the cursor leaves for the named target while
      // this call, and whatever the caller does next, still run.
      const aim = takeAim(request);
      if (aim) {
        line = JSON.stringify(request);
        void aimCursor(aim, resolveBox);
      }
      const droppedArgs = isRecord(request) && typeof request.method === "string"
        ? policeCallArguments(request) : [];
      if (droppedArgs.length > 0) line = JSON.stringify(request);
      if (isRecord(request) && request.id !== undefined && typeof request.method === "string") {
        const prepared = await prepareRequest(request, {
          resolveBox, probeReachability, pendingRequests, droppedArgs,
        });
        if (!prepared) return;
        request = prepared.request;
        gate = prepared.gate;
        line = JSON.stringify(request);
      }
      const logRead = readLogBefore(request, pendingRequests, observer);
      if (request) await leadCursor(request, resolveBox, gate?.box ?? null);
      await logRead;
      child.stdin.write(`${line}\n`);
    }).catch(() => {
      child.stdin.write(`${line}\n`);
    });
  });
  input.on("close", () => {
    chain.finally(() => child.stdin.end());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
