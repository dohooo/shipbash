/**
 * The proxy's post-action observation: a page-changing tool result is held
 * while the harness reads the page that action produced, then released with
 * that page merged in, so looking costs the agent no model round of its own.
 *
 * The page it appends is the settled one (page-settle.mjs), and this is the
 * only place an action's page is settled: Jev's executor takes its next
 * reading once the held result is released. A click whose destination has not
 * rendered yet is not what the click did, and handing it back as the action's
 * effect is how a passing surface reads as a failure.
 *
 * Settled is not landed: a page can hold still while the request the action
 * sent is still out, and a page the product opens on its own afterwards goes
 * on loading its content. So the observation names the requests sent since
 * the action that have no answer yet (action-requests.mjs), and so does every
 * snapshot after it. The actor decides whether to look again; the proxy adds
 * no wait of its own.
 *
 * Cut to the pattern of the pointer-box resolver and the reachability probe:
 * synthetic ids over the daemon pipe the proxy already owns, pending entries
 * the downstream rewriter delivers to, and an outer timer that releases the
 * held action rather than letting a read that never returns keep it hostage.
 */
import {
  REQUEST_LOG_ARGS,
  REQUEST_LOG_TOOL,
  requestLog,
  startedAfter,
  unanswered,
  waitingNote,
} from "./action-requests.mjs";
import { mergeObservation } from "./conclusion-gate.mjs";
import { createHarnessGuidance } from "./harness-guidance.mjs";
import { settledPage } from "./page-settle.mjs";

/** Id prefix for the reads the proxy injects into the daemon's stdin. */
export const OBSERVE_ID_PREFIX = "__shipbash_observe_";
const OBSERVE_SNAPSHOT_LIMIT = 4_000;
// The outer bound on holding one action, inside which the settle rule's own
// budget fits: a daemon that stops answering costs the agent its observation,
// never its action.
const OBSERVE_HOSTAGE_MS = 8_000;
// Reading the request log holds the action about to be sent; a daemon that
// does not answer costs that action's requests their note, never the action.
const LOG_BEFORE_MS = 1_000;
const harnessGuidance = createHarnessGuidance();

/** The text of a tool result, or "" when it failed or carried none. */
function resultText(response) {
  const result = response?.result;
  if (typeof result !== "object" || result === null || result.isError === true) return "";
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((entry) => entry?.type === "text")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

/** The scope the held action ran in; the reads must observe that same page. */
function scopeOf(callArgs) {
  const args = {};
  if (typeof callArgs?.session === "string" && callArgs.session) args.session = callArgs.session;
  if (typeof callArgs?.namespace === "string" && callArgs.namespace) args.namespace = callArgs.namespace;
  return args;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * Builds the proxy's observer. `observe(pending, held)` holds a page-changing
 * action's result until its page settles and emits it exactly once: merged
 * with that page and the requests sent since the action that still have no
 * answer, or untouched when the reads let it down. From the first observed
 * action on, `annotating()` is true and `annotate(pending, held)` tells every
 * snapshot which requests sent since the last action still have none: the
 * action's own, and those the page sent after it, such as a page it opened
 * on its own loading its content. `logBefore(args)` reads the request log
 * just before an action is sent; the requests it does not hold were sent
 * since. `openLog(args)` turns the log on with the first call of any kind.
 */
export function createObservationRequester(write, pendingRequests, emit) {
  let counter = 0;
  /** The log just before the last observed action, and the origin its routes are named against. */
  let last = null;
  const ask = (inflight, name, args, pick = resultText) => new Promise((resolve) => {
    counter += 1;
    const id = `${OBSERVE_ID_PREFIX}${String(counter)}`;
    const finish = (response) => {
      inflight.delete(id);
      pendingRequests.delete(id);
      resolve(pick(response));
    };
    inflight.add(id);
    pendingRequests.set(id, { method: "tools/call", kind: "observe", at: Date.now(), deliver: finish });
    try {
      write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    } catch {
      finish(null);
    }
  });
  /** Holds `held` until `release` or the hostage timer emits it; `read` asks the daemon meanwhile. */
  const hold = (held) => {
    const inflight = new Set();
    let released = false;
    const release = (line) => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      // A read still in flight answers into a dead promise; drop its entry so
      // the late reply is swallowed instead of reaching the agent.
      for (const id of inflight) pendingRequests.delete(id);
      emit(line);
    };
    const timer = setTimeout(() => release(JSON.stringify(held)), OBSERVE_HOSTAGE_MS);
    timer.unref?.();
    return { read: (name, args, pick) => ask(inflight, name, args, pick), release };
  };
  const readLog = (read, scope) => read(REQUEST_LOG_TOOL, { ...scope, ...REQUEST_LOG_ARGS }, requestLog);
  /** The note on what, sent since the last action, still has no answer; null when nothing. */
  const noteFrom = (log) => (log && last ? waitingNote(unanswered(log, startedAfter(log, last.before, last.origin)), Date.now()) : null);

  const observe = (pending, held) => {
    const { read, release } = hold(held);
    const scope = scopeOf(pending.callArgs);
    const readPage = async () => ({
      url: await read("agent_browser_get_url", scope),
      snapshot: await read("agent_browser_snapshot", scope),
    });
    void settledPage(readPage)
      .then(async (page) => {
        const log = await readLog(read, scope);
        last = pending.logBefore ? { before: pending.logBefore, origin: originOf(page.url) } : null;
        const observation = { held, url: page.url, veilNote: pending.veilNote, waitingNote: noteFrom(log) };
        release(mergeObservation(observation, page.snapshot, harnessGuidance, OBSERVE_SNAPSHOT_LIMIT));
      })
      .catch(() => release(JSON.stringify(held)));
  };

  const annotate = (pending, held) => {
    const { read, release } = hold(held);
    void readLog(read, scopeOf(pending.callArgs))
      .then((log) => {
        const note = noteFrom(log);
        if (note) held.result.content.push({ type: "text", text: note });
        release(JSON.stringify(held));
      })
      .catch(() => release(JSON.stringify(held)));
  };

  let opened = false;
  const logBefore = (args) => {
    opened = true;
    const inflight = new Set();
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), LOG_BEFORE_MS);
      timer.unref?.();
    });
    const at = Date.now();
    const reading = ask(inflight, REQUEST_LOG_TOOL, { ...scopeOf(args), ...REQUEST_LOG_ARGS }, (response) => {
      const hops = requestLog(response);
      return hops ? { hops, at } : null;
    });
    return Promise.race([reading, expired]).finally(() => {
      clearTimeout(timer);
      for (const id of inflight) pendingRequests.delete(id);
    });
  };

  // The log records only once it has been read, so it is read with the first
  // call of any kind: how often the page sent a request before the first
  // action is then known too.
  const openLog = async (args) => {
    if (!opened) await logBefore(args);
  };

  return { observe, annotate, annotating: () => last !== null, logBefore, openLog };
}
