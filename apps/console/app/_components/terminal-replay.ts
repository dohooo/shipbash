"use client";

/**
 * A finished run's terminal sessions, replayed under the recording's clock.
 *
 * The live panel takes whatever the socket hands it; a finished one has the
 * whole log up front and must instead hold it back until the moment it was
 * written. Each chunk the runner recorded carries the offset from its own
 * shell opening, so the moment it was written is the shell's epoch plus that
 * offset, and the recording's clock places that moment on the video: in the
 * segment of the walk it happened in, since a case run walked twice drops
 * the time between its walks.
 *
 * wterm exposes no reset(), so there is only one way to unwrite something:
 * clear the screen and replay from the start. Going forward stays cheap —
 * only what is new gets written — and going back costs one full replay, which
 * for a 1.6 MB log measures around 33 ms in the same wasm core.
 */

import type { RecordingClock } from "@shipbash/contracts/runtime/recording-clock.mjs";

import {
  appendChunk,
  broadcast,
  clearChunks,
  type FeedBuffer,
  type RetainedLogEntry,
  type RetainedLogReplay,
  TERMINAL_RESET,
} from "./terminal-feed";

interface ReplaySession extends FeedBuffer {
  /** The log's chunks, each `atMs` already where it lies on the recording's timeline. */
  entries: readonly RetainedLogEntry[];
  /** How many entries are on screen. A rewind is the only way this drops. */
  written: number;
}

interface TerminalReplayFeed extends RetainedLogReplay {
  /** Moves every loaded session to `tMs` on the recording's timeline. */
  seek(tMs: number): void;
}

/** Back to a blank screen, so the next pass can replay from the start. */
function rewind(session: ReplaySession): void {
  session.written = 0;
  clearChunks(session);
  broadcast(session, TERMINAL_RESET);
}

/** Writes every chunk the clock has now passed, and nothing it has not. */
function advance(session: ReplaySession, tMs: number): void {
  while (session.written < session.entries.length) {
    const entry = session.entries[session.written];
    if (!entry || entry.atMs > tMs) return;
    session.written += 1;
    appendChunk(session, entry.bytes);
    broadcast(session, entry.bytes);
  }
}

/**
 * A terminal feed whose sessions play under a clock the caller drives.
 * `timeAt` turns an epoch millisecond into a position on the video's
 * timeline: the recording's own clock (runtime/recording-clock.mjs).
 */
export function createTerminalReplayFeed(timeAt: RecordingClock): TerminalReplayFeed {
  const sessions = new Map<string, ReplaySession>();
  let clockMs = 0;
  const stateFor = (sessionId: string): ReplaySession => {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    const created: ReplaySession = {
      entries: [],
      written: 0,
      chunks: [],
      bytes: 0,
      listeners: new Set(),
    };
    sessions.set(sessionId, created);
    return created;
  };
  return {
    load(sessionId, entries, startedAt) {
      const session = stateFor(sessionId);
      session.entries = entries.map((entry) => ({ atMs: timeAt(startedAt + entry.atMs), bytes: entry.bytes }));
      // A reload replaces what the session had on screen; a first load has
      // nothing to clear, and a reset then would blank a screen the
      // subscriber has only just been handed.
      if (session.written > 0) rewind(session);
      advance(session, clockMs);
    },
    seek(tMs) {
      const next = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
      const rewinding = next < clockMs;
      clockMs = next;
      for (const session of sessions.values()) {
        if (rewinding) rewind(session);
        advance(session, next);
      }
    },
    subscribe(sessionId, listener) {
      const session = stateFor(sessionId);
      // The emulator is fresh, but the reader may be rejoining a session that
      // already played: the reset first, then the screen as it stands.
      listener(TERMINAL_RESET);
      for (const chunk of session.chunks) listener(chunk);
      session.listeners.add(listener);
      return () => {
        session.listeners.delete(listener);
      };
    },
  };
}
