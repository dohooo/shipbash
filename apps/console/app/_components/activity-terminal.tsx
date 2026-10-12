"use client";

/**
 * The Discovery workbench's Terminal tab: the sandbox shell sessions the agent
 * opens, mirrored read-only through the same stream socket as the browser.
 *
 * The socket stays owned by ActivityBrowserStream; it forwards the terminal
 * messages here. The lane hook lives with the page so the sessions list and
 * the byte feed survive the panel being absent (the tab only exists once a
 * session opens) and tab switches (the panel stays mounted but hidden).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { TerminalScreen, type TerminalInputSender } from "./activity-terminal-screen";
import {
  createFeedHub,
  type RetainedLogEntry,
  type RetainedLogReplay,
  TERMINAL_RESET,
  type TerminalFeed,
} from "./terminal-feed";
import { insertRetainedSession, type RetainedSessionKey } from "./terminal-session-order";

/**
 * A session's PTY grid, which the panel renders cell for cell. The lane is its
 * one source: it announces the grid with the session and records it in the
 * log's header.
 */
interface Grid {
  cols: number;
  rows: number;
}

export interface TermSession extends Grid {
  id: string;
  title: string;
  owner: "agent" | "user";
}

function cellCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The grid a session announcement or a log header names, if it names one. */
function gridOf(source: object): Grid | null {
  const cols = cellCount("cols" in source ? source.cols : null);
  const rows = cellCount("rows" in source ? source.rows : null);
  return cols && rows ? { cols, rows } : null;
}

/** A session log the completed run retained, served by the activity API. */
export interface RetainedTerminalLog {
  sessionId: string;
  url: string;
  /** Where the recording's terminal track puts this session; null when it has none. */
  order: number | null;
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function sessionFrom(candidate: unknown): TermSession | null {
  if (candidate === null || typeof candidate !== "object") return null;
  const id = "id" in candidate && typeof candidate.id === "string" ? candidate.id : "";
  // A session is drawn on the grid it announces or not at all.
  const grid = gridOf(candidate);
  if (!id || !grid) return null;
  const title = "title" in candidate && typeof candidate.title === "string" && candidate.title
    ? candidate.title
    : "sandbox";
  const owner = "owner" in candidate && candidate.owner === "user" ? "user" : "agent";
  return { id, title, owner, ...grid };
}

function parseSessions(value: unknown): TermSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => sessionFrom(candidate) ?? []);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

interface RetainedLog extends Grid {
  title: string;
  /** The epoch the shell opened at, from the header. */
  startedAt: number;
  entries: RetainedLogEntry[];
}

/** NDJSON per the runner's recording: a header object, then [ms,"o",base64]. */
function parseRetainedLog(text: string): RetainedLog | null {
  const [headerLine, ...lines] = text.split("\n");
  const header = parseJsonLine(headerLine ?? "");
  if (header === null || typeof header !== "object" || Array.isArray(header)) return null;
  // The grid the shell ran at; a log without one cannot be replayed faithfully.
  const grid = gridOf(header);
  if (!grid) return null;
  const title = "title" in header && typeof header.title === "string" && header.title
    ? header.title
    : "sandbox";
  // The epoch the shell opened at. It is the only ordering key a log carries
  // on its own, and the fallback for a run whose recording named no order.
  const started = "startedAt" in header && typeof header.startedAt === "string"
    ? Date.parse(header.startedAt)
    : Number.NaN;
  const startedAt = Number.isFinite(started) ? started : 0;
  // Each chunk keeps the offset the runner wrote it at. That offset is what
  // lets a replay run the session at the pace it actually ran; a panel with
  // no clock to follow joins the chunks back into one block.
  const entries = lines.flatMap((line) => {
    const entry = parseJsonLine(line);
    if (!Array.isArray(entry) || entry[1] !== "o" || typeof entry[2] !== "string") return [];
    const bytes = decodeBase64(entry[2]);
    const atMs = Number(entry[0]);
    if (!bytes || !Number.isFinite(atMs)) return [];
    return [{ atMs: Math.max(0, atMs), bytes }];
  });
  return { title, startedAt, ...grid, entries };
}

/** The whole log as one block, the way a panel without a clock takes it. */
function joinEntries(entries: readonly RetainedLogEntry[]): Uint8Array {
  const bytes = new Uint8Array(entries.reduce((total, entry) => total + entry.bytes.length, 0));
  let offset = 0;
  for (const entry of entries) {
    bytes.set(entry.bytes, offset);
    offset += entry.bytes.length;
  }
  return bytes;
}

/**
 * Replays a retained log into the feed as if it were a joining snapshot.
 * Resolves false when the log could not be fetched or parsed, so the caller
 * can retry on a later pass instead of losing the session for good.
 */
async function hydrateRetainedLog(
  log: RetainedTerminalLog,
  deliver: (sessionId: string, parsed: RetainedLog) => void,
  setSessions: Dispatch<SetStateAction<readonly TermSession[]>>,
  keys: Map<string, RetainedSessionKey>,
): Promise<boolean> {
  let parsed: RetainedLog | null = null;
  try {
    const response = await fetch(log.url);
    if (response.ok) parsed = parseRetainedLog(await response.text());
  } catch {
    // An unreachable log stays out of the panel until a retry lands.
  }
  if (!parsed) return false;
  deliver(log.sessionId, parsed);
  const { title, startedAt, cols, rows } = parsed;
  const key = { order: log.order, startedAt };
  setSessions((current) => insertRetainedSession(
    current,
    { id: log.sessionId, title, owner: "agent", cols, rows },
    keys,
    key,
  ));
  return true;
}

const NO_RETAINED_LOGS: readonly RetainedTerminalLog[] = [];

/**
 * Terminal-lane state for one Activity page: the sessions list and the byte
 * feed, fed by the stream pane's socket via handleTermMessage — or, once the
 * run is over and there was no live socket to watch, by the retained logs.
 */
export function useTerminalLane(
  retained: readonly RetainedTerminalLog[] = NO_RETAINED_LOGS,
  /** Given one, the logs play under its clock instead of arriving at once. */
  replay: RetainedLogReplay | null = null,
): {
  sessions: readonly TermSession[];
  feed: TerminalFeed;
  handleTermMessage: (message: Record<string, unknown>) => boolean;
} {
  const [sessions, setSessions] = useState<readonly TermSession[]>([]);
  // Every screen binds it once, as with the replay feed, so it lives as long
  // as the lane.
  const [hub] = useState(createFeedHub);
  // A session the live socket already delivered keeps its (fuller) scrollback;
  // hydration only fills sessions this page never saw live.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Records SUCCESSFUL hydrations only: a transient fetch failure retries on
  // the next pass (the page's polling recomputes `retained` every round).
  // `pending` keeps a retry-eligible failure from double-fetching mid-flight.
  const hydratedRef = useRef(new Set<string>());
  const pendingRef = useRef(new Set<string>());
  // The ordering keys of every session hydrated so far: sorting an arriving
  // one needs the keys of the ones already listed.
  const keysRef = useRef(new Map<string, RetainedSessionKey>());
  const deliver = useCallback((sessionId: string, parsed: RetainedLog) => {
    if (replay) {
      replay.load(sessionId, parsed.entries, parsed.startedAt);
      return;
    }
    hub.push(sessionId, TERMINAL_RESET, true);
    hub.push(sessionId, joinEntries(parsed.entries), false);
  }, [hub, replay]);
  useEffect(() => {
    for (const log of retained) {
      if (hydratedRef.current.has(log.sessionId) || pendingRef.current.has(log.sessionId)) continue;
      if (sessionsRef.current.some((session) => session.id === log.sessionId)) continue;
      pendingRef.current.add(log.sessionId);
      void hydrateRetainedLog(log, deliver, setSessions, keysRef.current).then((hydrated) => {
        pendingRef.current.delete(log.sessionId);
        if (hydrated) hydratedRef.current.add(log.sessionId);
      });
    }
  }, [deliver, retained]);
  const handleTermMessage = useCallback((message: Record<string, unknown>) => {
    switch (message.type) {
      case "term_sessions": {
        setSessions(parseSessions(message.sessions));
        return true;
      }
      case "term_snapshot":
      case "term_data": {
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
        const bytes = typeof message.data === "string" ? decodeBase64(message.data) : null;
        if (sessionId && bytes) {
          if (message.type === "term_snapshot") hub.push(sessionId, TERMINAL_RESET, true);
          hub.push(sessionId, bytes, false);
        }
        return true;
      }
      // Sessions close only with the run; the panel keeps the last scrollback.
      case "term_closed":
        return true;
      default:
        return false;
    }
  }, [hub]);
  return { sessions, feed: replay ?? hub, handleTermMessage };
}

export function ActivityTerminal({
  sessions,
  feed,
  live,
  input,
  activeSessionId = null,
}: {
  sessions: readonly TermSession[];
  feed: TerminalFeed;
  /** A running session accepts takeover keystrokes; a finished one is history. */
  live: boolean;
  /** Non-null while the viewer holds the control lease: keystrokes go through
   * it, and the panel wears the same amber takeover treatment as the browser. */
  input: TerminalInputSender | null;
  /** The shell the recorded attention track says the agent was typing in. */
  activeSessionId?: string | null;
}) {
  // The panel is chromeless — no session tabs, no status row. The recorded
  // track names the shell the agent was actually in, which is not always the
  // newest one (terminal_run can name an earlier session and go back to it).
  // Without a track — a live run, or a case whose recording never landed —
  // the newest session is still the best reading.
  const active = sessions.find((session) => session.id === activeSessionId)
    ?? sessions[sessions.length - 1] ?? null;
  return (
    <div className="activity-terminal">
      <div className="term" data-takeover-active={input && live ? "true" : undefined}>
        {/* Every session's emulator stays mounted: wterm holds the scrollback,
            and remounting would replay only the retained tail. Hidden by
            visibility, not display: wterm measures its cells as it starts and
            the fit measures the panel, and a display:none box measures 0×0.
            The screens stack in one grid cell (`.term-screen`), so each keeps
            the panel's box; inert also drops a hidden session's textarea from
            focus, so takeover keystrokes cannot keep flowing to a session
            that is off screen. */}
        {sessions.map((session) => (
          <div
            key={session.id}
            className="term-screen"
            inert={session.id !== active?.id}
            style={{ visibility: session.id === active?.id ? undefined : "hidden" }}
          >
            <TerminalScreen
              sessionId={session.id}
              cols={session.cols}
              rows={session.rows}
              feed={feed}
              input={live ? input : null}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
