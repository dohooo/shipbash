// How a walk (jev-executor.mjs) reads the page and the terminal beside it,
// and how it waits on a busy one: for the page to move, or, after an input to
// the terminal, for the running command's screen to change.
import { splitWaiting } from "./action-requests.mjs";
import { JevStop } from "./jev-stops.mjs";
import { movedPage, readingKey } from "./page-settle.mjs";

// A busy round right after the walk's input went to the terminal, whose
// command is still running (`terminal.running`, the shell's own marks), is
// waited on again while the reading stays as it was, for up to a minute, then
// handed back: a silent `npm i -g` outlasted the one five-second wait, and the
// walk ran its next command in a new session while the install was still
// going. A hook has five minutes; a command silent longer
// than this one is pi's to watch. The minute bounds one unchanged stretch: a
// command that keeps printing is judged again at each change, and waited on
// until the walk's rounds or the lane's own budget run out. Any other busy
// round keeps its one wait: a page that never moves beside a server the walk
// left running in the terminal took a minute and a hand-back instead of five
// seconds and its step.
const RUNNING_WAIT_MAX_MS = 60_000;

/** Ends the walk between rounds when it is aborted, or the owner is waiting. */
export function checkInterruption(run) {
  run.signal.throwIfAborted();
  if (run.shouldYield()) throw new JevStop("owner_input");
}

/**
 * One reading of the live page, the pair every judgement is made on, the
 * requests sent since the last action that the browser says still wait, and
 * the terminal's newest session as it stands, or null.
 */
export async function readPage(run) {
  const url = (await run.call("agent_browser_get_url", {})).trim();
  const { page: snapshot, waiting } = splitWaiting(await run.call("agent_browser_snapshot", { interactive: false }));
  return { url, snapshot, waiting, terminal: run.readTerminal?.() ?? null };
}

/**
 * Waits until the page has moved on from the reading the round was decided
 * on, and returns the reading it ended on. A busy frame is settled but not done,
 * so a wait ends when the page has left it, and the next iteration judges the
 * page it moved to; a busy page that never moves is judged again unchanged,
 * and one that settles nothing is handed back (jev-checklist.mjs judge).
 */
export function movedFrom(run) {
  return movedPage(
    () => readPage(run),
    run.reading,
    // motionMaxMs: how long a page gets to move before it is taken as still.
    { signal: run.signal, maxMs: run.motionMaxMs },
  );
}

/**
 * A busy round's wait: until the page moves (movedFrom). When the walk's last
 * input went to the terminal and the reading it ends on is unchanged with the
 * command still running, the wait goes on, up to RUNNING_WAIT_MAX_MS from its
 * start, and a command still running past it is handed back. The cap is per
 * unchanged reading, not per command: a changed reading ends the wait, and the
 * round that judges it starts a new one. A command waiting for input reads
 * not busy and is never waited on here. An interruption ends it between waits,
 * as it ends the walk between rounds.
 */
export async function waitOut(run) {
  // runningWaitMaxMs: how long a running page is waited out.
  const deadline = Date.now() + (run.runningWaitMaxMs ?? RUNNING_WAIT_MAX_MS);
  const from = readingKey(run.reading);
  const toTerminal = run.lastTool?.startsWith("terminal_") ?? false;
  for (;;) {
    const reached = await movedFrom(run);
    if (!toTerminal || !reached.terminal?.running || readingKey(reached) !== from) return null;
    if (Date.now() >= deadline) return "command_running";
    checkInterruption(run);
  }
}
