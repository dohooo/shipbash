/**
 * The contract a terminal screen reads its bytes through, the reset every feed
 * writes ahead of a fresh screen, and the live lane's feed. The replay's
 * clock-driven feed (terminal-replay.ts) implements the same contract.
 */

export interface TerminalFeed {
  /** Replays the session's retained tail, then delivers live bytes. */
  subscribe(sessionId: string, listener: (data: Uint8Array) => void): () => void;
}

/** One chunk of a session's recorded output, at the offset it was written at. */
export interface RetainedLogEntry {
  /** Milliseconds after the header's `startedAt`. */
  atMs: number;
  bytes: Uint8Array;
}

/**
 * A feed that decides for itself when a loaded log reaches the panel. The
 * lane hands it the whole log and stops there; a clock-driven replay
 * (terminal-replay.ts) holds each chunk until the moment it was written.
 */
export interface RetainedLogReplay extends TerminalFeed {
  load(
    sessionId: string,
    entries: readonly RetainedLogEntry[],
    /** The epoch the shell opened at, from the log's own header. */
    startedAt: number,
  ): void;
}

// RIS, then ED 3: what precedes every snapshot, which replaces whatever the
// emulator holds (a reconnect replays it into a terminal that already has
// content), and every replay rewind (terminal-replay.ts). RIS alone blanks
// only the screen: wterm keeps the lines that scrolled off above it, where a
// reader scrolling up would find them. ED 3 erases that scrollback.
export const TERMINAL_RESET = Uint8Array.from([0x1b, 0x63, 0x1b, 0x5b, 0x33, 0x4a]);

// What a subscriber arriving after the bytes did (the wasm core loads
// asynchronously) is handed. The live lane matches the sidecar's retained-tail
// bound; for a replay it only keeps the buffer from growing without bound,
// since wterm's own scrollback is a fixed ring of about a thousand lines.
const BUFFER_LIMIT_BYTES = 128 * 1024;

/** A session's retained output and who is listening for more of it. */
export interface FeedBuffer {
  chunks: Uint8Array[];
  bytes: number;
  listeners: Set<(data: Uint8Array) => void>;
}

/** Keeps a chunk, dropping the oldest ones past the bound but never the newest. */
export function appendChunk(buffer: FeedBuffer, bytes: Uint8Array): void {
  buffer.chunks.push(bytes);
  buffer.bytes += bytes.length;
  while (buffer.bytes > BUFFER_LIMIT_BYTES && buffer.chunks.length > 1) {
    const dropped = buffer.chunks.shift();
    if (dropped) buffer.bytes -= dropped.length;
  }
}

/**
 * Hands bytes to every listener. A listener that throws is a dead emulator (a
 * torn-down wterm whose ready callback landed late). Evicting it keeps one
 * corpse from starving every listener behind it in the set — the screen keeps
 * painting, and the corpse never blocks again.
 */
export function broadcast(buffer: FeedBuffer, bytes: Uint8Array): void {
  for (const listener of buffer.listeners) {
    try {
      listener(bytes);
    } catch {
      buffer.listeners.delete(listener);
    }
  }
}

/** Forgets the retained output; the listeners stay. */
export function clearChunks(buffer: FeedBuffer): void {
  buffer.chunks = [];
  buffer.bytes = 0;
}

interface TerminalFeedHub extends TerminalFeed {
  push(sessionId: string, bytes: Uint8Array, reset: boolean): void;
}

export function createFeedHub(): TerminalFeedHub {
  const sessions = new Map<string, FeedBuffer>();
  const stateFor = (sessionId: string): FeedBuffer => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: FeedBuffer = { chunks: [], bytes: 0, listeners: new Set() };
    sessions.set(sessionId, created);
    return created;
  };
  return {
    push(sessionId, bytes, reset) {
      const state = stateFor(sessionId);
      if (reset) clearChunks(state);
      appendChunk(state, bytes);
      broadcast(state, bytes);
    },
    subscribe(sessionId, listener) {
      const state = stateFor(sessionId);
      for (const chunk of state.chunks) listener(chunk);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  };
}
