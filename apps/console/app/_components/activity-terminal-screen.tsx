"use client";

/**
 * One session's emulator in the Discovery workbench's Terminal tab: a wterm
 * fed by the lane's byte feed, read-only until takeover typing hands it a
 * sender. Split from activity-terminal.tsx, which owns the lane state.
 *
 * The screen is the recorded screen. The emulator runs at the session's own
 * grid, the PTY's, and never refits to the panel: wterm does not reflow, so
 * on any other grid whatever a program placed by row and column (a wrapped
 * command line, a full-width progress bar, vim, less, top) lands in the wrong
 * cells. The fixed grid is scaled into the panel instead, the way
 * asciinema-player fits a recording: always whole, larger in a larger panel.
 */

import { useCallback, useEffect, useRef } from "react";
import { Terminal, type TerminalHandle, type WTerm } from "@wterm/react";
// The bare "@wterm/react/css" alias resolves to this same sheet but carries no
// type declaration; the .css-suffixed export satisfies the ambient *.css type.
import "@wterm/dom/src/terminal.css";

import type { TerminalFeed } from "./terminal-feed";

// The runner refuses term_input beyond this many bytes per message.
const INPUT_CHUNK_BYTES = 4_096;

/**
 * Keystrokes as ≤4 KiB base64 messages, in order. A paste arrives as one
 * onData string that can exceed the runner's per-message cap — chunking here
 * keeps the cap a transport bound instead of silently dropping the paste
 * (byte-boundary splits are fine: the pty reassembles the sequential stream).
 */
function encodeInputChunks(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
    const piece = bytes.subarray(offset, offset + INPUT_CHUNK_BYTES);
    let binary = "";
    for (const byte of piece) binary += String.fromCharCode(byte);
    chunks.push(btoa(binary));
  }
  return chunks;
}

/**
 * Keeps the grid scaled to the largest size that fits whole inside the box
 * (globals.css reads --term-scale). The emulator's own element is the
 * scroller and spans the box, so its scrollbar sits at the panel's edge; the
 * grid is centred inside it. What has to fit is therefore the grid's own
 * width plus the scroller's side padding and gutters, never the scroller's
 * width, which follows the scale. Both sizes are watched: the panel changes
 * with the card, and the grid's laid-out width follows the glyphs in its rows
 * (the same 100 columns measured 759 or 760 px, depending on the output).
 */
function fitGrid(box: HTMLElement, terminal: HTMLElement): () => void {
  const grid = terminal.querySelector<HTMLElement>(".term-grid");
  if (!grid) throw new Error("wterm became ready without its .term-grid");
  // The theme's side padding, fixed for the emulator's life.
  const style = getComputedStyle(terminal);
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const fit = () => {
    if (!grid.offsetWidth || !terminal.offsetHeight) return;
    const sides = terminal.offsetWidth - terminal.clientWidth + padding;
    const scale = Math.min(box.clientWidth / (grid.offsetWidth + sides), box.clientHeight / terminal.offsetHeight);
    box.style.setProperty("--term-scale", String(scale));
  };
  const observer = new ResizeObserver(fit);
  observer.observe(box);
  observer.observe(grid);
  return () => {
    observer.disconnect();
  };
}

/** Types keystrokes into one session over the stream socket, base64-encoded. */
export type TerminalInputSender = (sessionId: string, dataBase64: string) => void;

// Read-only: wterm echoes keystrokes locally when onData is omitted, so the
// default must swallow them instead. Takeover typing replaces this handler.
const READ_ONLY_INPUT = () => {};

export function TerminalScreen({
  sessionId,
  cols,
  rows,
  feed,
  input,
}: {
  sessionId: string;
  /** The PTY's grid: the lane's for a live session, the log header's for a retained one. */
  cols: number;
  rows: number;
  feed: TerminalFeed;
  input: TerminalInputSender | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const onReady = useCallback((wt: WTerm) => {
    // wterm calls this once per emulator, when its init resolves, so the feed
    // and session bound here are the ones it became ready with: a later feed
    // never reaches this screen, so a feed must live as long as its panel. A
    // torn-down wterm still resolves its init (React's dev double mount
    // creates and destroys one before the live instance, and its ready
    // callback can land last); only the wrapper's current instance owns the
    // feed.
    const box = boxRef.current;
    if (handleRef.current?.instance !== wt || !box) return;
    detachRef.current?.();
    // The fit starts only now: wterm measures its cells while it initialises,
    // and a scale already applied would skew the row height it locks in. In
    // fixed mode it never measures them again, so no ancestor may be
    // transformed while it mounts. It has also locked its height to the grid
    // by now, so the first write finds the screen at the bottom and follows
    // the output.
    const unfit = fitGrid(box, wt.element);
    const unsubscribe = feed.subscribe(sessionId, (data) => {
      wt.write(data);
    });
    detachRef.current = () => {
      unfit();
      unsubscribe();
    };
  }, [feed, sessionId]);
  useEffect(() => () => {
    detachRef.current?.();
    detachRef.current = null;
  }, []);
  return (
    <div ref={boxRef} className="term-fit">
      <Terminal
        ref={handleRef}
        cols={cols}
        rows={rows}
        wasmUrl="/wterm.wasm"
        theme="shipbash"
        onData={input
          ? (data) => {
            for (const chunk of encodeInputChunks(data)) input(sessionId, chunk);
          }
          : READ_ONLY_INPUT}
        onReady={onReady}
      />
    </div>
  );
}
