/**
 * Candidate motion paths and the scoring that picks one. Adapted from
 * open-browser-use's content-cursor.js; see agent-cursor-renderer.ts for the
 * notice.
 */

import {
  BASE_ROTATION,
  clamp,
  cubicPointFromControls,
  distanceBetween,
  normalizeDegrees,
  normalizeVector,
  vectorFromDegrees,
  type AgentCursorPoint,
} from "./agent-cursor-geometry";
import { pathResponse, selectPath } from "./agent-cursor-path-score";
import type { SpringParams } from "./agent-cursor-spring";

interface PathSegment {
  control1: AgentCursorPoint;
  control2: AgentCursorPoint;
  end: AgentCursorPoint;
}

export interface CursorPath {
  arc: AgentCursorPoint | null;
  arcIn: AgentCursorPoint | null;
  arcOut: AgentCursorPoint | null;
  end: AgentCursorPoint;
  endControl: AgentCursorPoint;
  segments: PathSegment[];
  start: AgentCursorPoint;
  startControl: AgentCursorPoint;
}

const PATH_CONFIG = {
  arcFlow: 0.5783555327868779,
  arcSize: 0.2765523188064277,
  boundsMargin: 20,
  clickAngleDegrees: -44,
  endpointHandle: 0.15,
  startHandle: 0.41960295031576633,
};

export function choosePath({
  bounds,
  end,
  start,
}: {
  bounds: { width: number; height: number };
  end: AgentCursorPoint;
  start: AgentCursorPoint;
}): CursorPath {
  return selectPath(buildPathCandidates({ bounds, end, start }), bounds, PATH_CONFIG);
}

export function samplePath(
  path: CursorPath,
  progress: number,
): { point: AgentCursorPoint; tangent: AgentCursorPoint } {
  const boundedProgress = clamp(progress, 0, 1);
  const segmentIndexFloat =
    boundedProgress === 1 ? path.segments.length - 1 : boundedProgress * path.segments.length;
  const segmentIndex = Math.floor(segmentIndexFloat);
  const segment = path.segments[segmentIndex];
  if (!segment) {
    throw new Error("Cursor motion path has no segment for progress");
  }
  const previousSegment = path.segments[segmentIndex - 1];
  const start = segmentIndex === 0 ? path.start : previousSegment?.end;
  if (!start) {
    throw new Error("Cursor motion path segment is missing its start point");
  }
  const segmentProgress = boundedProgress === 1 ? 1 : segmentIndexFloat - segmentIndex;
  return {
    point: cubicPoint(start, segment, segmentProgress),
    tangent: cubicTangent(start, segment, segmentProgress),
  };
}

export function angleFromTangent(tangent: AgentCursorPoint): number {
  if (distanceBetween({ x: 0, y: 0 }, tangent) < 0.001) {
    return normalizeDegrees(BASE_ROTATION);
  }
  const normal = normalizeVector(tangent);
  return normalizeDegrees(Math.atan2(normal.y, normal.x) * (180 / Math.PI) + 90);
}

export function pathSpringParams(path: CursorPath): SpringParams {
  return { dampingFraction: 0.9, response: pathResponse(path) };
}

function buildPathCandidates({
  bounds,
  end,
  start,
}: {
  bounds: { width: number; height: number };
  end: AgentCursorPoint;
  start: AgentCursorPoint;
}): CursorPath[] {
  const clickDirection = vectorFromDegrees(PATH_CONFIG.clickAngleDegrees);
  const distance = distanceBetween(start, end);
  const vector = { x: end.x - start.x, y: end.y - start.y };
  const direction = normalizeVector(vector);
  const startHandleDistance = Math.max(48, Math.min(640, distance * PATH_CONFIG.startHandle, distance * 0.9));
  const endHandleDistance = Math.max(48, Math.min(640, distance * PATH_CONFIG.endpointHandle, distance * 0.9));
  const reverseClickDirection = { x: -clickDirection.x, y: -clickDirection.y };
  const startControl = boundedControlPoint(bounds, start, clickDirection, startHandleDistance);
  const endControl = boundedControlPoint(bounds, end, reverseClickDirection, endHandleDistance);
  const naturalNormal = { x: -direction.y, y: direction.x };
  const normalSign = naturalNormal.x * clickDirection.x + naturalNormal.y * clickDirection.y >= 0 ? 1 : -1;
  const arcNormal = { x: naturalNormal.x * normalSign, y: naturalNormal.y * normalSign };
  const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const closerStartControl = boundedControlPoint(bounds, start, clickDirection, startHandleDistance * 0.65);
  const closerEndControl = boundedControlPoint(bounds, end, reverseClickDirection, endHandleDistance * 0.65);
  const arcTangent = normalizeVector(vector);
  const arcDistance = Math.max(50, Math.min(520, distance * PATH_CONFIG.arcSize));
  const arcHandleDistance = Math.max(38, Math.min(440, distance * PATH_CONFIG.arcFlow));
  const arcDistanceScales = [0.55, 0.8, 1.05];
  const arcHandleScales = [0.65, 1, 1.35];
  const candidates: CursorPath[] = [
    directPath(start, end, startControl, endControl),
    directPath(start, end, closerStartControl, closerEndControl),
  ];
  for (const arcDistanceScale of arcDistanceScales) {
    for (const arcHandleScale of arcHandleScales) {
      pushArcCandidates({
        arcDistanceBase: arcDistance,
        arcDistanceScale,
        arcHandleDistanceBase: arcHandleDistance,
        arcHandleScale,
        arcTangent,
        candidates,
        clickTangent: clickDirection,
        end,
        endControl,
        midpoint,
        naturalArcNormal: arcNormal,
        start,
        startControl,
        startControlDistance: startHandleDistance,
      });
    }
  }
  return candidates;
}

interface ArcCandidateOptions {
  arcDistanceBase: number;
  arcDistanceScale: number;
  arcHandleDistanceBase: number;
  arcHandleScale: number;
  arcTangent: AgentCursorPoint;
  candidates: CursorPath[];
  clickTangent: AgentCursorPoint;
  end: AgentCursorPoint;
  endControl: AgentCursorPoint;
  midpoint: AgentCursorPoint;
  naturalArcNormal: AgentCursorPoint;
  start: AgentCursorPoint;
  startControl: AgentCursorPoint;
  startControlDistance: number;
}

function pushArcCandidates(options: ArcCandidateOptions): void {
  pushArcCandidate({ ...options, arcNormal: options.naturalArcNormal });
  pushArcCandidate({
    ...options,
    arcNormal: { x: -options.naturalArcNormal.x, y: -options.naturalArcNormal.y },
  });
}

function pushArcCandidate({
  arcDistanceBase,
  arcDistanceScale,
  arcHandleDistanceBase,
  arcHandleScale,
  arcNormal,
  arcTangent,
  candidates,
  clickTangent,
  end,
  endControl,
  midpoint,
  start,
  startControl,
  startControlDistance,
}: ArcCandidateOptions & { arcNormal: AgentCursorPoint }): void {
  const arcDistance = arcDistanceBase * arcDistanceScale;
  const arcHandleDistance = arcHandleDistanceBase * arcHandleScale;
  const arc = {
    x: midpoint.x + arcNormal.x * arcDistance + clickTangent.x * startControlDistance * 0.16,
    y: midpoint.y + arcNormal.y * arcDistance + clickTangent.y * startControlDistance * 0.16,
  };
  const arcIn = { x: arc.x - arcTangent.x * arcHandleDistance, y: arc.y - arcTangent.y * arcHandleDistance };
  const arcOut = { x: arc.x + arcTangent.x * arcHandleDistance, y: arc.y + arcTangent.y * arcHandleDistance };
  candidates.push(arcPath({ arc, arcIn, arcOut, end, endControl, start, startControl }));
}

function directPath(
  start: AgentCursorPoint,
  end: AgentCursorPoint,
  startControl: AgentCursorPoint,
  endControl: AgentCursorPoint,
): CursorPath {
  return {
    arc: null,
    arcIn: null,
    arcOut: null,
    end,
    endControl,
    segments: [{ control1: startControl, control2: endControl, end }],
    start,
    startControl,
  };
}

function arcPath({
  arc,
  arcIn,
  arcOut,
  end,
  endControl,
  start,
  startControl,
}: {
  arc: AgentCursorPoint;
  arcIn: AgentCursorPoint;
  arcOut: AgentCursorPoint;
  end: AgentCursorPoint;
  endControl: AgentCursorPoint;
  start: AgentCursorPoint;
  startControl: AgentCursorPoint;
}): CursorPath {
  return {
    arc,
    arcIn,
    arcOut,
    end,
    endControl,
    segments: [
      { control1: startControl, control2: arcIn, end: arc },
      { control1: arcOut, control2: endControl, end },
    ],
    start,
    startControl,
  };
}

function boundedControlPoint(
  bounds: { width: number; height: number },
  point: AgentCursorPoint,
  direction: AgentCursorPoint,
  distance: number,
): AgentCursorPoint {
  let allowedDistance = distance;
  if (direction.x < 0) {
    allowedDistance = Math.min(allowedDistance, point.x / -direction.x);
  }
  if (direction.x > 0) {
    allowedDistance = Math.min(allowedDistance, (bounds.width - point.x) / direction.x);
  }
  if (direction.y < 0) {
    allowedDistance = Math.min(allowedDistance, point.y / -direction.y);
  }
  if (direction.y > 0) {
    allowedDistance = Math.min(allowedDistance, (bounds.height - point.y) / direction.y);
  }
  return {
    x: point.x + direction.x * Math.max(0, allowedDistance),
    y: point.y + direction.y * Math.max(0, allowedDistance),
  };
}

function cubicPoint(start: AgentCursorPoint, segment: PathSegment, progress: number): AgentCursorPoint {
  return cubicPointFromControls(start, segment.control1, segment.control2, segment.end, progress);
}

function cubicTangent(start: AgentCursorPoint, segment: PathSegment, progress: number): AgentCursorPoint {
  const inverse = 1 - progress;
  return {
    x:
      3 * inverse * inverse * (segment.control1.x - start.x) +
      6 * inverse * progress * (segment.control2.x - segment.control1.x) +
      3 * progress * progress * (segment.end.x - segment.control2.x),
    y:
      3 * inverse * inverse * (segment.control1.y - start.y) +
      6 * inverse * progress * (segment.control2.y - segment.control1.y) +
      3 * progress * progress * (segment.end.y - segment.control2.y),
  };
}
