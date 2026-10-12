/**
 * One `setState` pass over the cursor session: what the executor asked for,
 * which of the three snap branches (or the animated move) it takes, and the
 * bookkeeping that decides whether the pass reports an arrival.
 */

import { now } from "./agent-cursor-frame";
import { clamp, distanceBetween, type AgentCursorPoint } from "./agent-cursor-geometry";
import {
  beginCursorMotion,
  createCursorModel,
  snapCursor,
  type CursorModel,
} from "./agent-cursor-motion";
import { resetSpring } from "./agent-cursor-spring";

interface AgentCursorTarget extends AgentCursorPoint {
  visible?: boolean;
  moveSequence?: number;
  animateMovement?: boolean;
}

export interface AgentCursorState {
  cursor: AgentCursorTarget | null;
  isVisible: boolean;
  turnKey: string | null;
  viewportSize: { width: number; height: number };
}

/** The renderer's mutable bookkeeping across `setState` passes. */
interface CursorSession {
  activeArrivalKey: string | null;
  activeMoveSequence: number | null;
  appearedTurnKey: string | null;
  forceFirstFrame: boolean;
  model: CursorModel | null;
  reportedArrivalKey: string | null;
  thinkingTurnKey: string | null;
}

interface CursorInput {
  animateMovement: boolean;
  becameVisibleWithoutCursor: boolean;
  hasCursor: boolean;
  moveSequence: number | null;
  point: AgentCursorPoint;
  turnKey: string;
  visible: boolean;
}

const DEFAULT_X_RATIO = 0.58;
const DEFAULT_Y_RATIO = 0.55;

export function createCursorSession(): CursorSession {
  return {
    activeArrivalKey: null,
    activeMoveSequence: null,
    appearedTurnKey: null,
    forceFirstFrame: false,
    model: null,
    reportedArrivalKey: null,
    thinkingTurnKey: null,
  };
}

function normalizePoint({
  cursorX,
  cursorY,
  viewportHeight,
  viewportWidth,
}: {
  cursorX?: number | undefined;
  cursorY?: number | undefined;
  viewportHeight: number;
  viewportWidth: number;
}): AgentCursorPoint {
  return {
    x: clamp(cursorX ?? Math.round(viewportWidth * DEFAULT_X_RATIO), 0, viewportWidth),
    y: clamp(cursorY ?? Math.round(viewportHeight * DEFAULT_Y_RATIO), 0, viewportHeight),
  };
}

function resolveCursorInput(state: AgentCursorState): CursorInput {
  const turnKey = state.turnKey ?? "";
  const hasCursor = state.cursor != null;
  const point = normalizePoint({
    cursorX: state.cursor?.x,
    cursorY: state.cursor?.y,
    viewportHeight: state.viewportSize.height,
    viewportWidth: state.viewportSize.width,
  });
  const visible = state.isVisible !== false && state.cursor?.visible !== false;
  return {
    animateMovement: state.cursor?.animateMovement !== false,
    becameVisibleWithoutCursor: visible && !hasCursor,
    hasCursor,
    moveSequence: state.cursor?.moveSequence ?? null,
    point,
    turnKey,
    visible,
  };
}

/**
 * Applies one state to the session and returns the model to paint plus whether
 * this pass counts as an arrival. Every branch leaves the caller with the same
 * order: paint, then report, then schedule.
 */
export function applyCursorState(
  session: CursorSession,
  state: AgentCursorState,
): { model: CursorModel; reportsArrival: boolean } {
  const input = resolveCursorInput(state);
  session.activeMoveSequence = input.moveSequence;
  session.activeArrivalKey =
    input.moveSequence == null ? null : `${input.turnKey}:${String(input.moveSequence)}`;
  session.model ??= createCursorModel(input.point, input.visible);
  const model = session.model;
  model.visibilitySpring.target = input.visible ? 1 : 0;
  if (input.becameVisibleWithoutCursor && session.thinkingTurnKey !== input.turnKey) {
    session.thinkingTurnKey = input.turnKey;
    resetSpring(model.visibilitySpring, 1);
    model.thinkStartedAt = now();
  }
  if (!input.hasCursor) {
    snapCursor(model, input.point);
    return { model, reportsArrival: false };
  }
  return { model, reportsArrival: applyCursorTarget(session, model, input, state.viewportSize) };
}

function applyCursorTarget(
  session: CursorSession,
  model: CursorModel,
  input: CursorInput,
  viewportSize: { width: number; height: number },
): boolean {
  const shouldAppear =
    input.moveSequence != null &&
    input.visible &&
    model.visibilitySpring.value <= 0.001 &&
    session.appearedTurnKey !== input.turnKey;
  const distance = distanceBetween(model.point, input.point);
  model.thinkStartedAt = null;
  if (!input.animateMovement || shouldAppear || distance < 0.5) {
    if (shouldAppear) {
      session.appearedTurnKey = input.turnKey;
      resetSpring(model.visibilitySpring, 1);
    }
    snapCursor(model, input.point);
    if (!input.animateMovement) {
      model.stretchSpring.force = 0;
      model.stretchSpring.value = 1;
      model.stretchSpring.velocity = 0;
    }
    return true;
  }
  beginCursorMotion(model, input.point, viewportSize);
  session.forceFirstFrame = true;
  return false;
}
