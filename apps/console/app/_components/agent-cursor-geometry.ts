/**
 * Plane geometry for the agent cursor: the point type, the scalar and vector
 * helpers, and cubic Bezier evaluation. Adapted from open-browser-use's
 * content-cursor.js; see agent-cursor-renderer.ts for the notice.
 */

export interface AgentCursorPoint {
  x: number;
  y: number;
}

/** The angle the arrow art rests at, in degrees. */
export const BASE_ROTATION = -44;
/**
 * How far the cursor may squash across its travel axis. Both the motion model
 * that drives the squash and the transform that composes it clamp to this.
 */
export const MIN_SQUASH = 0;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function distanceBetween(a: AgentCursorPoint, b: AgentCursorPoint): number {
  const x = b.x - a.x;
  const y = b.y - a.y;
  return Math.sqrt(x * x + y * y);
}

export function normalizeVector(vector: AgentCursorPoint): AgentCursorPoint {
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y);
  return length < 0.001 ? { x: 1, y: 0 } : { x: vector.x / length, y: vector.y / length };
}

export function normalizeDegrees(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value;
}

export function shortestAngleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > 180) {
    delta -= 360;
  }
  while (delta < -180) {
    delta += 360;
  }
  return delta;
}

export function shortestRadiansDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

export function vectorDegrees(vector: AgentCursorPoint): number {
  return distanceBetween({ x: 0, y: 0 }, vector) < 0.001
    ? 0
    : Math.atan2(vector.y, vector.x) * (180 / Math.PI);
}

export function vectorFromDegrees(degrees: number): AgentCursorPoint {
  const radians = degrees * (Math.PI / 180);
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

export function pointInBounds(
  point: AgentCursorPoint,
  bounds: { width: number; height: number },
  margin: number,
): boolean {
  return (
    point.x >= margin &&
    point.x <= bounds.width - margin &&
    point.y >= margin &&
    point.y <= bounds.height - margin
  );
}

export function cubicPointFromControls(
  start: AgentCursorPoint,
  control1: AgentCursorPoint,
  control2: AgentCursorPoint,
  end: AgentCursorPoint,
  progress: number,
): AgentCursorPoint {
  const inverse = 1 - progress;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * progress;
  const c = 3 * inverse * progress * progress;
  const d = progress * progress * progress;
  return {
    x: start.x * a + control1.x * b + control2.x * c + end.x * d,
    y: start.y * a + control1.y * b + control2.y * c + end.y * d,
  };
}
