// Where the case agent's attention was, sampled from its own MCP tool calls.
//
// The runner is the one place the three timelines meet, on one clock
// (recording-now.mjs): the capture stamps each call with it,
// the stream recorder stamps the segment's first frame with it, and the
// terminal lane stamps its logs' epoch headers and output offsets with it.
// Collecting here also means the replayed console, the live follow and the
// exported video read one recorded answer rather than each deriving its own
// from host-timestamped events.
//
// Stamps are epoch milliseconds, each point the moment its call started: the
// replay is on a surface while the agent acts on it — a command being typed
// and printing, a click's pointer in flight — not only once the call has
// answered. A shell read is the exception (pointAtMs). Each point also keeps
// when its answer came back, which smart pacing plays at 1x too. The
// recording's finalizer is what converts them onto the video timeline,
// because only it knows where each segment landed on it.
import { isBackgroundTerminalCall, surfaceForTool } from "@shipbash/contracts/runtime/attention-track.mjs";
import { MAX_RECORDING_ATTENTION_POINTS } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import { isJevCall } from "./jev-tools.mjs";

/** A program's name, matching the bound the Activity lane's target uses. */
const MAX_LABEL_LENGTH = 60;
/** Matches the terminal tools' own `sessionId` bound (terminal-tools.mjs). */
const MAX_SESSION_ID_LENGTH = 64;
/**
 * The page readings Jev takes after every action, whichever surface it acted
 * on (jev-executor.mjs). They are not where its attention went: counted as
 * moves, they pulled the replay back to the browser some 20 ms after each
 * terminal command Jev ran, too short for a single frame, and a walk Jev took
 * in the terminal showed only the page (a Journey that managed a CLI's MCP
 * entries). The supervising agent's own reads are looks it chose, and count.
 */
const JEV_READINGS = new Set(["agent_browser_get_url", "agent_browser_snapshot"]);

/** The call's own arguments, or nothing when the lifecycle item carried none. */
function callArguments(completion) {
  const args = completion?.arguments;
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
}

/** A session id within the terminal tools' own bound, or null. */
function boundedSessionId(value) {
  return typeof value === "string" && value && value.length <= MAX_SESSION_ID_LENGTH ? value : null;
}

/**
 * The terminal session a call drove. `terminal_read` and `terminal_type`
 * always name one; the `terminal_run` that opens a session names none, and
 * the session it opened is the one its answer names, else the lane's newest
 * shown one — which is what the fallback reads.
 */
function sessionIdFor(surface, args, answered, newestTerminalSessionId) {
  if (surface !== "terminal") return null;
  return boundedSessionId(args.sessionId) ?? boundedSessionId(answered) ?? boundedSessionId(newestTerminalSessionId());
}

/** A shell word that sets a variable for the command after it: `NAME=value`. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** What a program's name looks like, once its directory is gone; anything else is no name. */
const PROGRAM_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${String(MAX_LABEL_LENGTH)}}$`, "u");

/**
 * The program a command line runs: past the variables set for it
 * (`PGPASSWORD=… psql`) and past `env` with its options and variables
 * (`env -i X=… node`), the first word, without its directory. Null when that
 * word is not a program's name — quoted, substituted, or nothing at all.
 */
function programOf(command) {
  const words = command.trim().split(/\s+/u);
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index] ?? "")) index += 1;
  if (words[index] === "env") {
    index += 1;
    while (index < words.length && (ASSIGNMENT.test(words[index] ?? "") || words[index]?.startsWith("-"))) index += 1;
  }
  const name = (words[index] ?? "").split("/").at(-1) ?? "";
  return PROGRAM_NAME.test(name) ? name : null;
}

/**
 * The program the agent ran, for the marker the reader hovers — its name
 * alone, never the line. A product's own install line may embed a token, and
 * a variable set for a command may be a password, and the playback document
 * is read by everyone on the team and on a share link, so the label is the
 * program alone (programOf) and the rest stays in the terminal log. Only
 * `terminal_run` has even that. `terminal_type` sends keystrokes into whatever
 * the shell is asking for, which is where a password would be, and a browser
 * call's arguments carry the text the agent typed into the page. The redactor
 * still runs, and the recording's finalizer masks the label whole again
 * (recording-playback.mjs), as further lines rather than the only one.
 */
function labelFor(surface, args, redact) {
  if (surface !== "terminal" || typeof args.command !== "string") return null;
  const program = programOf(args.command);
  const safe = program === null ? "" : String(redact(program)).trim();
  return safe ? safe.slice(0, MAX_LABEL_LENGTH) : null;
}

/**
 * Whether a call is where the agent's attention went. A call that names
 * neither surface — a checklist report, a narration — is not: the agent has
 * not left the surface it last drove; nor is one of Jev's page readings, nor a
 * call on a background shell, which the video never shows and which its
 * arguments name.
 * @param {"browser" | "terminal" | null} surface
 * @param {{ tool?: unknown, actionId?: unknown }} completion
 * @param {Record<string, unknown>} args
 */
function drawsAttention(surface, completion, args) {
  if (surface === null) return false;
  if (isJevCall(completion.actionId) && JEV_READINGS.has(String(completion.tool))) return false;
  return !(surface === "terminal" && isBackgroundTerminalCall(args));
}

/**
 * Where a call's point goes: where it began, except a shell read, which goes
 * where it answered. A read changes nothing on screen while it waits, and
 * what it shows is the output it waited for, so starting the shell's stretch
 * earlier would only show the wait.
 * @param {{ tool?: unknown, startedAtMs: number, answeredAtMs: number }} completion
 */
function pointAtMs(completion) {
  return String(completion.tool).endsWith("terminal_read") ? completion.answeredAtMs : completion.startedAtMs;
}

/**
 * @param {{ redact: (value: string) => unknown,
 *   newestTerminalSessionId?: () => string | null }} io
 */
export function createAttentionCollector({ redact, newestTerminalSessionId = () => null }) {
  const points = [];
  return {
    /**
     * One completed MCP tool call, stamped where pointAtMs puts it and where
     * it answered (`answeredAtMs`); answers whether the call is where the
     * agent's attention went (drawsAttention). A browser call while
     * the browser is in view moves nothing and adds no point, so the bound
     * counts moves; every shell call is one, the moment its shell's stretch
     * shows the agent acting there.
     * @param {{ tool?: unknown, arguments?: unknown, actionId?: unknown, sessionId?: unknown, startedAtMs: number, answeredAtMs: number }} completion
     */
    record(completion) {
      const surface = surfaceForTool(completion.tool);
      const args = callArguments(completion);
      if (!drawsAttention(surface, completion, args)) return false;
      if (surface === "browser" && points.at(-1)?.surface === "browser") return true;
      // Past the document's bound a walk's track stops growing: no walk can
      // keep more of it (recording-walks.mjs withinWalkShares).
      if (points.length >= MAX_RECORDING_ATTENTION_POINTS) return true;
      const sessionId = sessionIdFor(surface, args, completion.sessionId, newestTerminalSessionId);
      points.push({
        atMs: pointAtMs(completion), answeredAtMs: completion.answeredAtMs, surface, sessionId, label: labelFor(surface, args, redact),
      });
      return true;
    },
    /** The track so far. */
    snapshot() {
      return [...points];
    },
  };
}
