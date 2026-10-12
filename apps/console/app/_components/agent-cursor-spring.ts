/**
 * The 240 Hz spring integrator every cursor property rides on. Adapted from
 * open-browser-use's content-cursor.js; see agent-cursor-renderer.ts for the
 * notice.
 */

import { MIN_FRAME_SECONDS } from "./agent-cursor-frame";
import { shortestAngleDelta } from "./agent-cursor-geometry";

export interface Spring {
  dampingFraction: number;
  force: number;
  response: number;
  simulationTime: number;
  scriptTime: number;
  target: number;
  value: number;
  velocity: number;
}

export interface SpringParams {
  dampingFraction: number;
  response: number;
}

export const INTEGRATION_STEP_SECONDS = 1 / 240;
const MAX_SCRIPT_LAG_SECONDS = 1;
const SPRING_SETTLE_EPSILON = 0.001 * 60;

export function createSpring(value: number, target: number, params: SpringParams): Spring {
  return {
    dampingFraction: params.dampingFraction,
    force: 0,
    response: params.response,
    simulationTime: 0,
    scriptTime: 0,
    target,
    value,
    velocity: 0,
  };
}

export function resetSpring(spring: Spring, value: number): void {
  spring.force = 0;
  spring.simulationTime = 0;
  spring.scriptTime = 0;
  spring.target = value;
  spring.value = value;
  spring.velocity = 0;
}

export function stepSpring(spring: Spring, deltaSeconds: number): void {
  const response = Math.max(0.001, spring.response);
  const maxStiffness = 1 / (2 * INTEGRATION_STEP_SECONDS ** 2);
  const stiffness = Math.min((Math.PI * 2) ** 2 / response ** 2, maxStiffness);
  const damping = Math.sqrt(stiffness) * 2 * spring.dampingFraction;
  spring.scriptTime += Math.max(0, deltaSeconds);
  if (spring.scriptTime - spring.simulationTime > MAX_SCRIPT_LAG_SECONDS) {
    spring.simulationTime = spring.scriptTime - MIN_FRAME_SECONDS;
  }
  while (spring.simulationTime < spring.scriptTime) {
    integrateSpring(spring, stiffness, damping);
    spring.simulationTime += INTEGRATION_STEP_SECONDS;
  }
  if (springAtRest(spring)) {
    spring.value = spring.target;
  }
}

function integrateSpring(spring: Spring, stiffness: number, damping: number): void {
  const halfStep = INTEGRATION_STEP_SECONDS / 2;
  const midpointVelocity = spring.velocity + spring.force * halfStep;
  spring.value += midpointVelocity * INTEGRATION_STEP_SECONDS;
  spring.force = midpointVelocity * -damping + (spring.target - spring.value) * stiffness;
  spring.velocity = midpointVelocity + spring.force * halfStep;
}

function springAtRest(spring: Spring): boolean {
  if (
    Math.max(spring.velocity * spring.velocity, spring.force * spring.force) >
    SPRING_SETTLE_EPSILON * SPRING_SETTLE_EPSILON
  ) {
    return false;
  }
  const targetWindow = spring.target * 0.01;
  const delta = spring.target - spring.value;
  return targetWindow === 0 || delta * delta <= targetWindow * targetWindow;
}

export function springSettled(spring: Spring): boolean {
  return spring.value === spring.target && springAtRest(spring);
}

export function setShortestRotationTarget(spring: Spring, target: number): void {
  spring.target = spring.value + shortestAngleDelta(spring.value, target);
}
