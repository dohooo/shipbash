"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createAgentCursorRenderer,
  type AgentCursorRenderer,
} from "./agent-cursor-renderer";

/**
 * One executor-resolved pointer target, in CSS viewport coordinates of the
 * tested page. `id` must change for every new pointer event so consecutive
 * actions on the same element still animate and pulse.
 */
export interface AgentPointerSignal {
  id: string;
  action: string;
  x: number;
  y: number;
}

/** Parses an `agent_pointer` message from the live browser stream. */
function pointerFromStreamMessage(
  message: Record<string, unknown>,
): (AgentPointerSignal & { seq: number }) | null {
  if (message.type !== "agent_pointer") return null;
  const seq = Number(message.seq);
  const x = Number(message.x);
  const y = Number(message.y);
  if (![seq, x, y].every(Number.isFinite)) return null;
  return {
    id: `stream-${String(seq)}`,
    seq,
    action: typeof message.action === "string" ? message.action : "click",
    x,
    y,
  };
}

/**
 * Merges the cursor's two delivery channels. The live stream is authoritative:
 * the MCP proxy publishes each pointer BEFORE the action runs and the message
 * rides the same WebSocket as the screencast frames, so it is deduped by
 * sequence number alone — a repeat click on the same element still pulses.
 * Persisted events echo the same pointers seconds later; they only apply when
 * they bring a genuinely new position (stream down or historic catch-up), so
 * an echo never re-animates or re-pulses the cursor.
 */
/**
 * While the stream is delivering pointers, persisted echoes are ALWAYS stale:
 * applying one would fly the cursor back to a previous target (the A→B→A
 * rubber-banding effect). The fallback only takes over after the stream has
 * been silent this long — i.e. it is genuinely down, not merely older.
 */
const STREAM_AUTHORITY_MS = 10_000;

export function useAgentPointerFeed(): {
  pointer: AgentPointerSignal | null;
  applyStreamMessage: (message: Record<string, unknown>) => void;
  applyFallback: (candidate: AgentPointerSignal | null) => void;
} {
  const [pointer, setPointer] = useState<AgentPointerSignal | null>(null);
  const lastRef = useRef<{ seq: number; action: string; x: number; y: number } | null>(null);
  const lastStreamAtRef = useRef(0);
  const applyStreamMessage = useCallback((message: Record<string, unknown>) => {
    const candidate = pointerFromStreamMessage(message);
    if (!candidate) return;
    const sourceAt = Number(message.at);
    if (Number.isFinite(sourceAt) && sourceAt > 0) {
      // Latency diagnostics: how old is this pointer by the time the browser
      // applies it? (proxy publish -> channel poll -> WS relay -> here)
      console.debug("[agent-pointer]", `seq=${String(candidate.seq)}`, `age=${String(Date.now() - sourceAt)}ms`);
    }
    lastStreamAtRef.current = Date.now();
    if (lastRef.current && candidate.seq <= lastRef.current.seq) return;
    lastRef.current = { seq: candidate.seq, action: candidate.action, x: candidate.x, y: candidate.y };
    setPointer({ id: candidate.id, action: candidate.action, x: candidate.x, y: candidate.y });
  }, []);
  const applyFallback = useCallback((candidate: AgentPointerSignal | null) => {
    if (!candidate) return;
    // Persisted events lag the stream by seconds; while the stream is alive
    // they can only rubber-band the cursor backwards.
    if (Date.now() - lastStreamAtRef.current < STREAM_AUTHORITY_MS) return;
    const last = lastRef.current;
    if (
      last
      && last.action === candidate.action
      && Math.abs(last.x - candidate.x) < 0.75
      && Math.abs(last.y - candidate.y) < 0.75
    ) return;
    lastRef.current = { seq: last?.seq ?? 0, action: candidate.action, x: candidate.x, y: candidate.y };
    setPointer(candidate);
  }, []);
  return { pointer, applyStreamMessage, applyFallback };
}

const CLICK_PULSE_ACTIONS = new Set(["click", "dblclick", "check", "uncheck", "select"]);

interface OverlayState {
  moveSequence: number;
  lastPointerId: string | null;
  pendingPulse: { x: number; y: number } | null;
}

/**
 * The renderer state one apply pass produces, plus the pulse that pass queues
 * before handing the state over. Pure: the same props, box, move sequence and
 * animate flag always map to the same frame.
 */
function agentCursorFrame(
  props: {
    pointer: AgentPointerSignal | null;
    turnKey: string;
    viewport: { width: number; height: number } | null;
    visible: boolean;
  },
  box: { height: number; width: number },
  moveSequence: number,
  animate: boolean,
) {
  const { pointer, turnKey, viewport, visible } = props;
  const mapped =
    pointer &&
    viewport &&
    viewport.width > 0 &&
    viewport.height > 0 &&
    box.width > 0 &&
    box.height > 0
      ? {
          x: (pointer.x / viewport.width) * box.width,
          y: (pointer.y / viewport.height) * box.height,
        }
      : null;
  if (!mapped) {
    // Before the first executor coordinate arrives, the cursor parks at a
    // neutral default position in a think pose instead of hiding — the
    // viewer should see the Agent is present from the first second.
    return {
      pulse: null,
      state: {
        cursor: null,
        isVisible: visible && box.width > 0 && box.height > 0,
        turnKey,
        viewportSize: { width: Math.max(1, box.width), height: Math.max(1, box.height) },
      },
    };
  }
  return {
    pulse: animate && pointer && CLICK_PULSE_ACTIONS.has(pointer.action) ? mapped : null,
    state: {
      cursor: {
        animateMovement: animate,
        moveSequence,
        visible: true,
        x: mapped.x,
        y: mapped.y,
      },
      isVisible: visible,
      turnKey,
      viewportSize: { width: box.width, height: box.height },
    },
  };
}

/**
 * Animated Agent cursor above the live browser canvas. Renders exclusively in
 * ShipBash's viewer: nothing is injected into the tested page, and the cursor
 * stays hidden until a real executor coordinate arrives.
 */
export function AgentCursorOverlay({
  pointer,
  viewport,
  turnKey,
  visible,
}: {
  pointer: AgentPointerSignal | null;
  viewport: { width: number; height: number } | null;
  turnKey: string;
  visible: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<AgentCursorRenderer | null>(null);
  const boxRef = useRef({ height: 0, width: 0 });
  const overlayRef = useRef<OverlayState>({ moveSequence: 0, lastPointerId: null, pendingPulse: null });
  const propsRef = useRef({ pointer, turnKey, viewport, visible });
  propsRef.current = { pointer, turnKey, viewport, visible };

  const applyRef = useRef((animate: boolean) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const { pulse, state } = agentCursorFrame(
      propsRef.current,
      boxRef.current,
      overlayRef.current.moveSequence,
      animate,
    );
    if (pulse) overlayRef.current.pendingPulse = pulse;
    renderer.setState(state);
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const renderer = createAgentCursorRenderer(root, {
      onArrived: () => {
        // Timing diagnostics: when the cursor lands, relative to [agent-pointer]
        // arrival and [frame] activity.
        console.debug("[cursor-arrived]", propsRef.current.pointer?.id ?? "?", `t=${String(Date.now() % 100000)}`);
        const pulse = overlayRef.current.pendingPulse;
        if (!pulse) return;
        overlayRef.current.pendingPulse = null;
        rendererRef.current?.pulse(pulse);
      },
    });
    rendererRef.current = renderer;
    boxRef.current = { height: root.clientHeight, width: root.clientWidth };
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const entry = entries[0];
          if (!entry) return;
          boxRef.current = {
            height: entry.contentRect.height,
            width: entry.contentRect.width,
          };
          applyRef.current(false);
        });
    observer?.observe(root);
    return () => {
      observer?.disconnect();
      renderer.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pointer || pointer.id === overlayRef.current.lastPointerId) return;
    overlayRef.current.lastPointerId = pointer.id;
    overlayRef.current.moveSequence += 1;
    applyRef.current(true);
  }, [pointer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: applyRef reads the latest props, so the effect re-runs only when these three change.
  useEffect(() => {
    applyRef.current(false);
  }, [visible, turnKey, viewport]);

  return <div data-testid="agent-cursor-overlay" ref={rootRef} />;
}
