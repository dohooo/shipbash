/**
 * The cursor's motion model: the springs it carries, the two travel modes
 * (a long Bezier flight and the short "scoot"), and the idle think pose.
 * Adapted from open-browser-use's content-cursor.js; see
 * agent-cursor-renderer.ts for the notice.
 */

import {
  BASE_ROTATION,
  MIN_SQUASH,
  clamp,
  distanceBetween,
  lerp,
  normalizeDegrees,
  normalizeVector,
  vectorDegrees,
  type AgentCursorPoint,
} from "./agent-cursor-geometry";
import { angleFromTangent, choosePath, pathSpringParams, samplePath, type CursorPath } from "./agent-cursor-path";
import {
  INTEGRATION_STEP_SECONDS,
  createSpring,
  resetSpring,
  setShortestRotationTarget,
  springSettled,
  stepSpring,
  type Spring,
  type SpringParams,
} from "./agent-cursor-spring";

type CursorMotion =
  | { mode: "bezier"; path: CursorPath; progressSpring: Spring }
  | {
      mode: "scoot";
      axisRotation: number;
      end: AgentCursorPoint;
      progressSpring: Spring;
      rotationTarget: number;
      start: AgentCursorPoint;
    };

export interface CursorModel {
  motion: CursorMotion | null;
  point: AgentCursorPoint;
  positionXSpring: Spring;
  positionYSpring: Spring;
  rotation: number;
  rotationSpring: Spring;
  scootAxisRotation: number;
  scootAxisSpring: Spring;
  scootRotationSpring: Spring;
  scootStretchSpring: Spring;
  stretchSpring: Spring;
  thinkStartedAt: number | null;
  visibilitySpring: Spring;
}

const ARRIVAL_DISTANCE = 0.85;
const ARRIVAL_VELOCITY = 12;
const SHORT_DISTANCE = 196;
const SCOOT_ROTATION_LIMIT = 70;
const SCOOT_STRETCH_MIX = 0.15;
const THINK_DURATION_SECONDS = 1.41;
const THINK_PERIOD_SECONDS = 0.66;
const THINK_ROTATION_DEGREES = 12.5;
const DEFAULT_POSITION_SPRING: SpringParams = { dampingFraction: 0.9, response: 0.19 };
const STRETCH_SPRING: SpringParams = { dampingFraction: 0.85, response: 0.2 };
const VISIBILITY_SPRING: SpringParams = { dampingFraction: 0.86, response: 0.42 };
const SCOOT_PROGRESS_SPRING: SpringParams = { dampingFraction: 0.94, response: 0.19 };
const ROTATION_SPRING: SpringParams = { dampingFraction: 0.9, response: 0.12 };
const SCOOT_ROTATION_SPRING: SpringParams = { dampingFraction: 0.82, response: 0.055 };
const SCOOT_STRETCH_SPRING: SpringParams = { dampingFraction: 0.86, response: 0.12 };

export function createCursorModel(point: AgentCursorPoint, visible: boolean): CursorModel {
  const visibility = visible ? 1 : 0;
  const rotation = normalizeDegrees(BASE_ROTATION);
  return {
    motion: null,
    point,
    positionXSpring: createSpring(point.x, point.x, DEFAULT_POSITION_SPRING),
    positionYSpring: createSpring(point.y, point.y, DEFAULT_POSITION_SPRING),
    rotation,
    rotationSpring: createSpring(rotation, rotation, ROTATION_SPRING),
    scootAxisRotation: 0,
    scootAxisSpring: createSpring(0, 0, ROTATION_SPRING),
    scootRotationSpring: createSpring(0, 0, SCOOT_ROTATION_SPRING),
    scootStretchSpring: createSpring(1, 1, SCOOT_STRETCH_SPRING),
    stretchSpring: createSpring(1, 1, STRETCH_SPRING),
    thinkStartedAt: null,
    visibilitySpring: createSpring(visibility, visibility, VISIBILITY_SPRING),
  };
}

export function beginCursorMotion(
  model: CursorModel,
  targetPoint: AgentCursorPoint,
  viewportSize: { width: number; height: number },
): void {
  model.thinkStartedAt = null;
  const startPoint = { x: model.point.x, y: model.point.y };
  if (distanceBetween(startPoint, targetPoint) <= SHORT_DISTANCE) {
    beginScootMotion(model, startPoint, targetPoint);
    return;
  }
  const path = choosePath({ bounds: viewportSize, end: targetPoint, start: startPoint });
  const springParams = pathSpringParams(path);
  setPositionSpring(model, adjustedPathResponse(springParams.response), springParams.dampingFraction);
  model.motion = {
    mode: "bezier",
    path,
    progressSpring: createSpring(0, 1, springParams),
  };
}

function beginScootMotion(
  model: CursorModel,
  startPoint: AgentCursorPoint,
  targetPoint: AgentCursorPoint,
): void {
  const scoot = scootGeometry(startPoint, targetPoint);
  setPositionSpring(model, DEFAULT_POSITION_SPRING.response, DEFAULT_POSITION_SPRING.dampingFraction);
  model.positionXSpring.target = targetPoint.x;
  model.positionYSpring.target = targetPoint.y;
  setShortestRotationTarget(model.rotationSpring, normalizeDegrees(BASE_ROTATION));
  setShortestRotationTarget(model.scootAxisSpring, scoot.axisRotation);
  model.motion = {
    axisRotation: scoot.axisRotation,
    end: targetPoint,
    mode: "scoot",
    progressSpring: createSpring(0, 1, SCOOT_PROGRESS_SPRING),
    rotationTarget: scoot.rotationTarget,
    start: startPoint,
  };
}

export function stepCursor(model: CursorModel, deltaSeconds: number, timestamp: number): boolean {
  const arrived = stepMotion(model, Math.max(0, deltaSeconds), timestamp);
  stepSpring(model.visibilitySpring, deltaSeconds);
  stepSpring(model.stretchSpring, deltaSeconds);
  stepSpring(model.scootStretchSpring, deltaSeconds);
  stepSpring(model.scootRotationSpring, deltaSeconds);
  return arrived;
}

function stepMotion(model: CursorModel, deltaSeconds: number, timestamp: number): boolean {
  if (model.motion == null) {
    model.stretchSpring.target = 1;
    model.scootStretchSpring.target = 1;
    model.scootRotationSpring.target = 0;
    return false;
  }
  model.thinkStartedAt = null;
  return model.motion.mode === "scoot"
    ? stepScootMotion(model, deltaSeconds, timestamp)
    : stepBezierMotion(model, deltaSeconds, timestamp);
}

function stepBezierMotion(model: CursorModel, deltaSeconds: number, timestamp: number): boolean {
  const motion = model.motion;
  if (motion?.mode !== "bezier") {
    return false;
  }
  model.scootStretchSpring.target = 1;
  model.scootRotationSpring.target = 0;
  stepSpring(motion.progressSpring, deltaSeconds);
  const progress = clamp(motion.progressSpring.value, 0, 1);
  const sample = samplePath(motion.path, progress);
  const rotation = angleFromTangent(sample.tangent);
  model.positionXSpring.target = sample.point.x;
  model.positionYSpring.target = sample.point.y;
  setShortestRotationTarget(model.rotationSpring, rotation);
  setShortestRotationTarget(model.scootAxisSpring, 0);
  const movement = stepPosition(model, deltaSeconds);
  model.stretchSpring.target = stretchFromSpeed(movement.speed);
  if (
    progress >= 0.999 &&
    Math.abs(motion.progressSpring.velocity) < 0.01 &&
    isAtPoint(model, sample.point)
  ) {
    const finalSample = samplePath(motion.path, 1);
    const finalRotation = angleFromTangent(finalSample.tangent);
    setPoint(model, finalSample.point);
    resetSpring(model.rotationSpring, finalRotation);
    model.rotation = finalRotation;
    resetSpring(model.scootAxisSpring, 0);
    model.scootAxisRotation = 0;
    resetSpring(model.stretchSpring, 1);
    model.motion = null;
    model.thinkStartedAt = timestamp;
    return true;
  }
  return false;
}

function stepScootMotion(model: CursorModel, deltaSeconds: number, timestamp: number): boolean {
  const motion = model.motion;
  if (motion?.mode !== "scoot") {
    return false;
  }
  stepSpring(motion.progressSpring, deltaSeconds);
  model.positionXSpring.target = motion.end.x;
  model.positionYSpring.target = motion.end.y;
  setShortestRotationTarget(model.scootAxisSpring, motion.axisRotation);
  setShortestRotationTarget(model.rotationSpring, normalizeDegrees(BASE_ROTATION));
  const progress = projectedProgress(stepPosition(model, deltaSeconds).point, motion.start, motion.end);
  const eased = Math.sin(Math.min(1, progress) * Math.PI);
  model.stretchSpring.target = 1;
  model.scootStretchSpring.target = scootStretch(progress);
  model.scootRotationSpring.target = motion.rotationTarget * eased;
  if (
    progress >= 0.999 &&
    Math.abs(motion.progressSpring.velocity) < 0.01 &&
    isAtPoint(model, motion.end)
  ) {
    setPoint(model, motion.end);
    resetSpring(model.rotationSpring, normalizeDegrees(BASE_ROTATION));
    model.rotation = model.rotationSpring.value;
    resetScoot(model);
    resetSpring(model.stretchSpring, 1);
    model.motion = null;
    model.thinkStartedAt = timestamp;
    return true;
  }
  return false;
}

export function isCursorAnimating(model: CursorModel): boolean {
  return (
    model.motion != null ||
    model.thinkStartedAt != null ||
    !springSettled(model.positionXSpring) ||
    !springSettled(model.positionYSpring) ||
    !springSettled(model.rotationSpring) ||
    !springSettled(model.scootAxisSpring) ||
    !springSettled(model.scootRotationSpring) ||
    !springSettled(model.scootStretchSpring) ||
    !springSettled(model.stretchSpring) ||
    !springSettled(model.visibilitySpring)
  );
}

export function idleRotation(model: CursorModel, timestamp: number): number {
  if (model.thinkStartedAt == null) {
    return model.rotation;
  }
  const elapsed = (timestamp - model.thinkStartedAt) / 1000;
  if (elapsed < 0) {
    return model.rotation;
  }
  const envelopeProgress = Math.min(1, elapsed / THINK_DURATION_SECONDS);
  const envelope = Math.sin(envelopeProgress * Math.PI);
  const swing = Math.sin((elapsed / THINK_PERIOD_SECONDS) * Math.PI * 2) * envelope;
  if (envelopeProgress >= 1) {
    model.thinkStartedAt = null;
    return model.rotation;
  }
  return model.rotation + swing * THINK_ROTATION_DEGREES;
}

function stretchFromSpeed(speed: number): number {
  return clamp(1 - speed / 5500, 0.65, 1);
}

function scootStretch(progress: number): number {
  return lerp(1, lerp(1, MIN_SQUASH, Math.sin(clamp(progress, 0, 1) * Math.PI)), SCOOT_STRETCH_MIX);
}

function adjustedPathResponse(response: number): number {
  return clamp(response * 0.18, 0.035, 0.12);
}

function setPositionSpring(model: CursorModel, response: number, dampingFraction: number): void {
  model.positionXSpring.response = response;
  model.positionYSpring.response = response;
  model.positionXSpring.dampingFraction = dampingFraction;
  model.positionYSpring.dampingFraction = dampingFraction;
}

function stepPosition(
  model: CursorModel,
  deltaSeconds: number,
): { point: AgentCursorPoint; speed: number } {
  const previous = model.point;
  stepSpring(model.positionXSpring, deltaSeconds);
  stepSpring(model.positionYSpring, deltaSeconds);
  stepSpring(model.rotationSpring, deltaSeconds);
  stepSpring(model.scootAxisSpring, deltaSeconds);
  const point = { x: model.positionXSpring.value, y: model.positionYSpring.value };
  const speed = distanceBetween(previous, point) / Math.max(deltaSeconds, INTEGRATION_STEP_SECONDS);
  model.point = point;
  model.rotation = model.rotationSpring.value;
  model.scootAxisRotation = model.scootAxisSpring.value;
  return { point, speed };
}

function isAtPoint(model: CursorModel, point: AgentCursorPoint): boolean {
  return (
    distanceBetween(model.point, point) <= ARRIVAL_DISTANCE &&
    Math.abs(model.positionXSpring.velocity) <= ARRIVAL_VELOCITY &&
    Math.abs(model.positionYSpring.velocity) <= ARRIVAL_VELOCITY
  );
}

function setPoint(model: CursorModel, point: AgentCursorPoint): void {
  model.point = point;
  resetSpring(model.positionXSpring, point.x);
  resetSpring(model.positionYSpring, point.y);
}

export function snapCursor(model: CursorModel, point: AgentCursorPoint): void {
  model.motion = null;
  setPoint(model, point);
  resetSpring(model.rotationSpring, normalizeDegrees(BASE_ROTATION));
  model.rotation = model.rotationSpring.value;
  resetScoot(model);
  resetSpring(model.stretchSpring, 1);
}

function resetScoot(model: CursorModel): void {
  resetSpring(model.scootAxisSpring, 0);
  resetSpring(model.scootRotationSpring, 0);
  resetSpring(model.scootStretchSpring, 1);
  model.scootAxisRotation = 0;
}

function scootGeometry(
  start: AgentCursorPoint,
  end: AgentCursorPoint,
): { axisRotation: number; rotationTarget: number } {
  const direction = normalizeVector({ x: end.x - start.x, y: end.y - start.y });
  return {
    axisRotation: vectorDegrees(direction),
    rotationTarget: clamp(direction.x * 0.75 + -direction.y * 0.62, -1, 1) * SCOOT_ROTATION_LIMIT,
  };
}

function projectedProgress(
  point: AgentCursorPoint,
  start: AgentCursorPoint,
  end: AgentCursorPoint,
): number {
  const vector = { x: end.x - start.x, y: end.y - start.y };
  const lengthSquared = vector.x * vector.x + vector.y * vector.y;
  if (lengthSquared < 0.001) {
    return 1;
  }
  return clamp(((point.x - start.x) * vector.x + (point.y - start.y) * vector.y) / lengthSquared, 0, 1);
}
