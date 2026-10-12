/**
 * The agent's side of the terminal lane: each request terminal-tools.mjs
 * makes, answered with the session's screen once the program has gone quiet,
 * once the text the agent waits for is on it, or at the bounded deadline —
 * and with the URLs a program opened in the run's browser since the last
 * answer.
 */
import { keySequence } from "./terminal-keys.mjs";

/**
 * A terminal call's answer: the session as the agent reads it. terminal_run's
 * description says what each field means.
 * @typedef {{
 *   sessionId: string,
 *   screen: string,
 *   scrolledOff?: string,
 *   altScreen?: boolean,
 *   running: boolean,
 *   exitCode?: number,
 *   found?: boolean,
 *   openedInBrowser?: string[],
 *   harness?: string,
 * }} TerminalAnswer
 */

/** The shell's own words for a program that is not installed. */
const COMMAND_NOT_FOUND = /command not found|not recognized as an internal or external command/u;
/** Handed back with a missing program (`brew` once ended the step). */
const SANDBOX_NOTE = "This terminal is your own Linux sandbox container, running as an unprivileged user without sudo, whose "
  + "global npm installs land under HOME. Look at what it has before you pick the step's variant, and use what is here "
  + "or install what the step needs from a registry it has; a program that is not installed is not where the step stops.";

async function waitForQuiet(lane, session, sinceMs) {
  const deadline = sinceMs + lane.waitMs;
  while (!session.closed && lane.now() < deadline) {
    if (lane.now() - Math.max(session.lastOutputAt, sinceMs) >= lane.quietMs) return;
    await lane.sleep(50);
  }
}

/** Until `text` is on the screen or the bounded deadline, whichever is first; whether it was. */
async function waitForText(lane, session, text, sinceMs) {
  const deadline = sinceMs + lane.textWaitMs;
  while (!session.closed && lane.now() < deadline) {
    if (session.screen.shows(text)) return true;
    await lane.sleep(50);
  }
  return session.screen.shows(text);
}

/**
 * The session as the agent reads it now. A URL a program opened before the
 * answer is open, and named, by the time the agent reads it — so it never
 * opens the same page a second time. The sandbox note rides only on lines
 * the agent has not read yet, not on every answer while the line stays up.
 * @returns {Promise<{ ok: true } & TerminalAnswer>}
 */
async function screenResponse(lane, session, found) {
  await lane.spool.drain();
  const { scrolledOff, screen, altScreen, fresh } = session.screen.take();
  const opened = lane.spool.takeOpened();
  return {
    ok: true,
    sessionId: session.id,
    ...(scrolledOff ? { scrolledOff } : {}),
    screen,
    ...(altScreen ? { altScreen } : {}),
    ...session.command.read(),
    ...(found === undefined ? {} : { found }),
    ...(opened.length > 0 ? { openedInBrowser: opened } : {}),
    ...(COMMAND_NOT_FOUND.test(fresh) ? { harness: SANDBOX_NOTE } : {}),
  };
}

async function answerAfterWrite(lane, session, text) {
  const wroteAt = lane.now();
  if (text === null) {
    await waitForQuiet(lane, session, wroteAt);
    return screenResponse(lane, session, undefined);
  }
  return screenResponse(lane, session, await waitForText(lane, session, text, wroteAt));
}

/** The input as given, then each key, in one write. */
function typeInto(session, request) {
  const input = typeof request.input === "string" ? request.input : "";
  const keys = Array.isArray(request.keys) ? request.keys : [];
  const applicationCursorKeys = session.screen.cursorKeysApp();
  session.child.stdin?.write(input + keys.map((name) => keySequence(name, applicationCursorKeys)).join(""));
}

/** The text a request waits to see, or null for the quiet window. */
function awaitedText(request) {
  return typeof request.waitForText === "string" && request.waitForText.trim() !== "" ? request.waitForText : null;
}

async function executeRequest(lane, request, openReadySession) {
  const text = awaitedText(request);
  const noSession = { ok: false, error: `No open terminal session ${String(request.sessionId)}.` };
  if (request.op === "run" && typeof request.command === "string") {
    const session = request.sessionId === undefined
      ? await openReadySession(request.background === true)
      : lane.sessions.get(request.sessionId);
    if (!session || session.closed) return noSession;
    session.command.sent();
    session.child.stdin?.write(`${request.command}\n`);
    return answerAfterWrite(lane, session, text);
  }
  if (request.op === "type") {
    const session = lane.sessions.get(request.sessionId);
    if (!session || session.closed) return noSession;
    typeInto(session, request);
    return answerAfterWrite(lane, session, text);
  }
  if (request.op === "read") {
    const session = lane.sessions.get(request.sessionId);
    if (!session) {
      return { ok: false, error: `Unknown terminal session ${String(request.sessionId)}.` };
    }
    return screenResponse(lane, session, text === null ? undefined : await waitForText(lane, session, text, lane.now()));
  }
  return { ok: false, error: "Unknown terminal request." };
}

/**
 * Answers one request of the agent's: the screen, or what refused it. A
 * failure (a HOME the lane could not prepare, a key it does not know) is the
 * agent's answer, never a tool call left waiting.
 * @returns {Promise<Record<string, unknown>>}
 */
export function answerRequest(lane, request, openReadySession) {
  return executeRequest(lane, request, openReadySession).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}
