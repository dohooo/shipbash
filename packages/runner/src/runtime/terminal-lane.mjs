/**
 * Terminal lane: agent-created shell sessions inside the run container.
 *
 * The lane rides the screencast sidecar's WebSocket (term_sessions /
 * term_snapshot / term_data / term_closed out, term_input in): the sidecar
 * gates term_input behind the same control lease as browser input and hands
 * the message here, so the terminal adds no socket, no port, and no second
 * input authority.
 *
 * The PTY is util-linux `script`, not node-pty: the image already carries it,
 * and the wire protocol has no resize, so a fixed geometry removes everything
 * a native PTY binding would add (a compiler toolchain in the image build).
 * stdin is a pipe, which births the child pty at 0x0 — the command line pins
 * the real size before the interactive shell starts.
 *
 * The agent reaches the lane through terminal_run / terminal_read /
 * terminal_type (terminal-tools.mjs), each a request answered here, in this
 * process, rather than by the host. A URL a program in the shell opens is
 * spooled (terminal-open-spool.mjs) and opened in the run's browser through
 * the owner's `openUrl`.
 *
 * The agent reads each session's rendered screen (terminal-screen.mjs), not
 * its bytes, and sees it unmasked, with whether the shell is running a
 * command and how the last one exited (terminal-command.mjs). The live panel
 * and a joining viewer's scrollback — the operator's alone; the public live
 * relay carries none of it — have each chunk's registered secrets replaced as
 * it arrives, a best effort. The recording is written raw while the session
 * runs and masked whole when the lane closes (terminal-recording-masking.mjs),
 * before anyone reads it: the one copy that is kept is the one that can be
 * shown.
 *
 * A background session (terminal_run's `background: true`) is the same shell
 * kept off camera: no viewer is told it exists or sent its output, no viewer
 * types into it, Jev never reads it, and it opens no milestone. Its log is
 * written, masked and kept like any other, as evidence.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

import { createCommandState } from "./terminal-command.mjs";
import { maskTerminalRecording } from "./terminal-recording-masking.mjs";
import { createTerminalScreen } from "./terminal-screen.mjs";
import { createOpenSpool } from "./terminal-open-spool.mjs";
import { answerRequest } from "./terminal-requests.mjs";
import { TERMINAL_RC_FILE, shellEnvironment } from "./terminal-shell.mjs";
import { OUTPUT_QUIET_MS, OUTPUT_WAIT_MS, TEXT_WAIT_MS } from "./terminal-tools.mjs";

// The session geometry for its whole life (the wire carries no resize), and
// its one definition: term_sessions announces it and the recording's header
// records it, and every viewer renders the grid it is handed.
export const TERMINAL_COLS = 100;
export const TERMINAL_ROWS = 30;
export const TERMINAL_SESSION_TITLE = "sandbox · bash";
// The retained scrollback replayed to a joining viewer as term_snapshot.
const RETAINED_TAIL_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 4_096;
// How often the spool of URLs a program opened is read.
const SPOOL_POLL_MS = 200;

/** The sessions a viewer is shown: every one but the background ones. */
function shownSessions(lane) {
  return [...lane.sessions.values()].filter((session) => !session.background);
}

// Every shown session, closed ones included: a shell that exited keeps its tab
// and scrollback (term_closed narrates the exit, it does not unlist), and a
// viewer who reconnects must see the same panel the one who stayed kept.
function sessionsMessage(lane) {
  return {
    type: "term_sessions",
    sessions: shownSessions(lane).map((session) => ({
      id: session.id,
      title: session.title,
      owner: "agent",
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    })),
  };
}

function recordLine(lane, session, line) {
  session.writes = session.writes
    .then(() => lane.fs.appendFile(
      session.recordingPath,
      `${JSON.stringify(line)}\n`,
      { encoding: "utf8", mode: 0o600 },
    ))
    .catch(() => undefined);
}

function onOutput(lane, session, chunk) {
  if (session.closed) return;
  session.lastOutputAt = lane.now();
  session.screen.write(chunk);
  session.command.write(chunk);
  recordLine(lane, session, [lane.now() - session.startedAtMs, "o", chunk.toString("base64")]);
  const live = Buffer.from(lane.redactor.redactTerminalText(session.liveDecoder.write(chunk)), "utf8");
  session.tail = Buffer.concat([session.tail, live]).subarray(-RETAINED_TAIL_BYTES);
  if (!session.background) lane.broadcast?.({ type: "term_data", sessionId: session.id, data: live.toString("base64") });
}

function closeSession(lane, session) {
  if (session.closed) return;
  session.closed = true;
  session.command.end();
  if (!session.background) lane.broadcast?.({ type: "term_closed", sessionId: session.id });
}

/**
 * The session's recording, masked whole. A recording that cannot be masked is
 * not kept: the raw file goes, and the lane says so. The agent's shell and
 * the verdict are untouched either way.
 */
async function maskRecording(lane, session) {
  try {
    await maskTerminalRecording(session.recordingPath, { redactor: lane.redactor, scan: lane.scanSecrets, fs: lane.fs });
  } catch {
    await lane.fs.rm(session.recordingPath, { force: true }).catch(() => undefined);
    lane.onLogStopped("Terminal session log withheld: its output could not be masked", session.id);
  }
}

async function openSession(lane, background) {
  const openDirectory = await lane.spool.directory();
  const screen = await createTerminalScreen(TERMINAL_COLS, TERMINAL_ROWS);
  lane.sessionCounter += 1;
  // The nonce keys the id to THIS container: an auth-parked run resumes in a
  // fresh container whose counter restarts, and a viewer who never left the
  // page keys tabs and scrollback by bare id — colliding ids would splice two
  // different shells into one screen. The prefix says whether the session is
  // in the background (isBackgroundSession, attention-track.mjs).
  const id = `${background ? "bg" : "term"}-${lane.nonce}-${String(lane.sessionCounter)}`;
  const startedAtMs = lane.now();
  // Every session opens in the one workspace, and the prompt says so. Bash
  // reads /etc/bash.bashrc, then the lane's rc file (terminal-bashrc) in place
  // of ~/.bashrc: the user's ~/.bashrc, then the lane's prompt.
  const child = lane.spawnProcess("script", [
    "-qefc",
    `stty rows ${String(TERMINAL_ROWS)} cols ${String(TERMINAL_COLS)}; mkdir -p ~/work && cd ~/work; exec bash --rcfile '${TERMINAL_RC_FILE}' -i`,
    "/dev/null",
  ], {
    cwd: lane.homeDirectory,
    env: shellEnvironment(lane.homeDirectory, openDirectory),
  });
  const session = {
    id,
    title: TERMINAL_SESSION_TITLE,
    background,
    child,
    closed: false,
    startedAtMs,
    lastOutputAt: startedAtMs,
    tail: Buffer.alloc(0),
    screen,
    command: createCommandState(),
    liveDecoder: new StringDecoder("utf8"),
    recordingMasked: false,
    recordingPath: join(lane.outputRoot, "terminal", `${id}.ndjson`),
    // The mkdir heads the write chain so the header line can never race it.
    writes: lane.fs.mkdir(join(lane.outputRoot, "terminal"), { recursive: true }),
  };
  lane.sessions.set(id, session);
  recordLine(lane, session, {
    v: 1,
    sessionId: id,
    title: session.title,
    startedAt: new Date(startedAtMs).toISOString(),
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
  });
  child.stdout?.on("data", (chunk) => onOutput(lane, session, chunk));
  child.stderr?.on("data", (chunk) => onOutput(lane, session, chunk));
  child.on("error", () => closeSession(lane, session));
  child.on("exit", () => closeSession(lane, session));
  if (background) return session;
  if (!lane.milestoneEmitted) {
    lane.milestoneEmitted = true;
    lane.onSessionOpened("Terminal session opened · sandbox", id);
  }
  lane.broadcast?.(sessionsMessage(lane));
  return session;
}

/**
 * A fresh session's shell must speak (its first prompt) before the lane types
 * into it: writing earlier gets the line echoed twice — once by the kernel
 * while bash is still starting, once by readline's own redraw.
 */
async function openReadySession(lane, background) {
  const session = await openSession(lane, background);
  const readyBy = lane.now() + 2_000;
  while (session.tail.length === 0 && !session.closed && lane.now() < readyBy) {
    await lane.sleep(20);
  }
  return session;
}

function joinMessages(lane) {
  const shown = shownSessions(lane);
  if (shown.length === 0) return [];
  return [
    sessionsMessage(lane),
    ...shown
      .filter((session) => session.tail.length > 0)
      .map((session) => ({
        type: "term_snapshot",
        sessionId: session.id,
        data: session.tail.toString("base64"),
      })),
  ];
}

function routeInput(lane, message) {
  const session = lane.sessions.get(message.sessionId);
  if (!session || session.closed || session.background || typeof message.data !== "string") return;
  const bytes = Buffer.from(message.data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) return;
  session.child.stdin?.write(bytes);
}

async function closeLane(lane) {
  lane.running = false;
  for (const session of lane.sessions.values()) {
    if (session.closed) continue;
    // util-linux `script` ignores SIGHUP, so a HUP'd session outlives the run
    // and its open stdio pipes hold this process — and with it the container,
    // the leg, and the Activity's "running" status — alive forever. EOF plus
    // SIGTERM end the shell; destroying the pipes releases the event loop
    // even if something inside the pty lingers.
    session.child.stdin?.end();
    session.child.kill("SIGTERM");
    session.child.stdout?.destroy();
    session.child.stderr?.destroy();
    closeSession(lane, session);
  }
  await lane.spool.close();
  await Promise.all([...lane.sessions.values()].map((session) => session.writes));
  await Promise.all([...lane.sessions.values()].filter((session) => !session.recordingMasked).map(async (session) => {
    session.recordingMasked = true;
    await maskRecording(lane, session);
  }));
}

/** Runs `task` every poll interval while the lane runs; a failed pass waits for the next. */
async function poll(lane, task) {
  while (lane.running) {
    await task().catch(() => undefined);
    await lane.sleep(lane.pollMs);
  }
}

/**
 * `redactor` is the runner's own (runner-redaction.mjs): the secrets it
 * registered, and the patterns its events pass through, mask the shell's
 * output. The lane says two things: the first session opened
 * (`onSessionOpened`), and a session whose log it did not keep because its
 * output could not be masked (`onLogStopped`); each gets the words to say it
 * in and the session's id. `openUrl` opens a URL a program in the shell
 * opened, in the run's browser, and keeps it on the owner's record. `now` is
 * the recording's clock (recording-now.mjs), which stamps each log's header
 * and its output, so a shell's output lands on the frame it was printed on.
 */
export function createTerminalLane({
  outputRoot, homeDirectory, redactor, onSessionOpened, onLogStopped, openUrl, now, io = {},
}) {
  const fs = io.fs ?? { appendFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile };
  const lane = {
    outputRoot,
    homeDirectory,
    redactor,
    onSessionOpened,
    onLogStopped,
    scanSecrets: io.scanSecrets,
    spool: createOpenSpool({ fs, openUrl }),
    spawnProcess: io.spawnProcess ?? spawn,
    fs,
    now,
    sleep: io.sleep ?? delay,
    quietMs: io.quietMs ?? OUTPUT_QUIET_MS,
    waitMs: io.waitMs ?? OUTPUT_WAIT_MS,
    textWaitMs: io.textWaitMs ?? TEXT_WAIT_MS,
    pollMs: io.pollMs ?? SPOOL_POLL_MS,
    sessions: new Map(),
    broadcast: null,
    nonce: io.nonce ?? randomBytes(3).toString("hex"),
    sessionCounter: 0,
    milestoneEmitted: false,
    running: false,
  };
  return {
    /** The sidecar hands its broadcast here; messages fan out to every viewer. */
    bind(broadcast) {
      lane.broadcast = broadcast;
    },
    joinMessages: () => joinMessages(lane),
    /**
     * Every session this lane opened, in the order it opened them, closed ones
     * included. A Map iterates in insertion order, so this IS the open order —
     * which is what the recording's terminal track is sorted by and what tells
     * a viewer which shell the agent is typing in. Survives close(): a lane's
     * sessions are its record, not its live handles. A background session is
     * not listed: the video never shows it. Each names the log it is recorded
     * in (`logPath`), which the recording's finalizer draws it from.
     */
    sessions: () => shownSessions(lane).map((session) => ({
      sessionId: session.id,
      title: session.title,
      startedAtMs: session.startedAtMs,
      logPath: session.recordingPath,
    })),
    /**
     * The newest shown session's screen and command as the agent reads them,
     * for a reader in this process (Jev), without taking anything from the
     * agent's next read. Null before the first shown session.
     */
    screen() {
      const session = shownSessions(lane).at(-1);
      return session ? { sessionId: session.id, ...session.screen.peek(), ...session.command.read() } : null;
    },
    input: (message) => routeInput(lane, message),
    /**
     * Answers one of the agent's terminal requests (terminal-requests.mjs).
     * @param {Record<string, unknown>} request
     */
    request: (request) => answerRequest(lane, request, (background) => openReadySession(lane, background)),
    // A URL a program opens is opened while its answer still waits on the
    // program, by a loop of its own.
    start() {
      lane.running = true;
      void poll(lane, () => lane.spool.drain());
    },
    close: () => closeLane(lane),
  };
}
