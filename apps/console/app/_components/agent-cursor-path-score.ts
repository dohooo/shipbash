/**
 * How the cursor picks one candidate path and how long it takes to fly it.
 * Adapted from open-browser-use's content-cursor.js; see
 * agent-cursor-renderer.ts for the notice.
 */

import {
  BASE_ROTATION,
  clamp,
  cubicPointFromControls,
  distanceBetween,
  normalizeVector,
  pointInBounds,
  shortestRadiansDelta,
  vectorFromDegrees,
} from "./agent-cursor-geometry";
import type { CursorPath } from "./agent-cursor-path";

export function selectPath(
  candidates: CursorPath[],
  bounds: { width: number; height: number },
  config: { boundsMargin: number },
): CursorPath {
  const first = candidates[0];
  if (!first) {
    throw new Error("Cursor motion requires at least one candidate");
  }
  let bestInBounds = first;
  let bestInBoundsScore = Number.POSITIVE_INFINITY;
  let bestAny = first;
  let bestAnyScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const metrics = pathMetrics(candidate, bounds, config.boundsMargin);
    const score = pathScore(candidate, metrics);
    if (score < bestAnyScore) {
      bestAny = candidate;
      bestAnyScore = score;
    }
    if (metrics.staysInBounds && score < bestInBoundsScore) {
      bestInBounds = candidate;
      bestInBoundsScore = score;
    }
  }
  return bestInBoundsScore === Number.POSITIVE_INFINITY ? bestAny : bestInBounds;
}

interface PathMetrics {
  angleChangeEnergy: number;
  length: number;
  maxAngleChange: number;
  staysInBounds: boolean;
  totalTurn: number;
}

function pathMetrics(
  path: CursorPath,
  bounds: { width: number; height: number } | null = null,
  margin = 0,
): PathMetrics {
  let length = 0;
  let angleChangeEnergy = 0;
  let maxAngleChange = 0;
  let totalTurn = 0;
  let previousAngle: number | null = null;
  let staysInBounds = !bounds || pointInBounds(path.start, bounds, margin);
  let segmentStart = path.start;
  let previousPoint = path.start;
  for (const segment of path.segments) {
    for (let i = 1; i <= 24; i += 1) {
      const progress = i / 24;
      const point = cubicPointFromControls(segmentStart, segment.control1, segment.control2, segment.end, progress);
      length += distanceBetween(previousPoint, point);
      if (bounds) {
        staysInBounds = staysInBounds && pointInBounds(point, bounds, margin);
      }
      const delta = { x: point.x - previousPoint.x, y: point.y - previousPoint.y };
      if (distanceBetween({ x: 0, y: 0 }, delta) > 0.01) {
        const angle = Math.atan2(delta.y, delta.x);
        if (previousAngle != null) {
          const angleDelta = shortestRadiansDelta(previousAngle, angle);
          angleChangeEnergy += angleDelta * angleDelta;
          maxAngleChange = Math.max(maxAngleChange, Math.abs(angleDelta));
          totalTurn += Math.abs(angleDelta);
        }
        previousAngle = angle;
      }
      previousPoint = point;
    }
    segmentStart = segment.end;
  }
  return { angleChangeEnergy, length, maxAngleChange, staysInBounds, totalTurn };
}

function pathScore(path: CursorPath, metrics: PathMetrics): number {
  const directDistance = Math.max(1, distanceBetween(path.start, path.end));
  const extraLength = Math.max(0, metrics.length / directDistance - 1);
  const arcPenalty = path.arc == null ? 0 : 45;
  const directionPenalty = pathDirectionPenalty(path);
  return (
    metrics.length +
    extraLength * 320 +
    metrics.angleChangeEnergy * 140 +
    metrics.maxAngleChange * 180 +
    metrics.totalTurn * 18 +
    directionPenalty * 90 +
    arcPenalty
  );
}

function pathDirectionPenalty(path: CursorPath): number {
  const clickDirection = vectorFromDegrees(BASE_ROTATION);
  const direction = normalizeVector({ x: path.end.x - path.start.x, y: path.end.y - path.start.y });
  return clamp((-(direction.x * clickDirection.x + direction.y * clickDirection.y) - 0.08) / 0.92, 0, 1);
}

export function pathResponse(path: CursorPath): number {
  const metrics = pathMetrics(path);
  const directDistance = Math.max(1, distanceBetween(path.start, path.end));
  const extraLength = Math.max(0, metrics.length / directDistance - 1);
  const distanceFactor = clamp((metrics.length - 180) / 760, 0, 1);
  const extraFactor = clamp(extraLength / 0.55, 0, 1);
  const turnFactor = clamp(metrics.totalTurn / (Math.PI * 1.4), 0, 1);
  const energyFactor = clamp(metrics.angleChangeEnergy / 1.25, 0, 1);
  const complexity = clamp(extraFactor * 0.42 + turnFactor * 0.38 + energyFactor * 0.2, 0, 1);
  const directionFactor = pathDirectionPenalty(path);
  const arcBonus = path.arc == null ? 0 : 0.04;
  const directionBonus = directionFactor * 0.28;
  const arcMultiplier = path.arc == null ? 1 : 0.9;
  return clamp(
    (0.42 + distanceFactor * 0.22 + complexity * 0.12 + directionBonus + arcBonus) * 0.7 * arcMultiplier,
    0.12,
    2.2,
  );
}

