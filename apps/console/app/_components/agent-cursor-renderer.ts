/**
 * Agent cursor motion renderer for ShipBash's browser viewport overlay.
 *
 * The motion engine (candidate Bezier paths, 240 Hz spring integration, the
 * short-distance "scoot" move, the idle think pose, and the transform
 * composition) and the bundled arrow asset are adapted from
 * open-browser-use's content-cursor.js at commit 07a8014:
 * https://github.com/iFurySt/open-browser-use
 *
 * MIT License
 *
 * Copyright (c) 2026 Leo
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ShipBash adaptations: the cursor renders inside a ShipBash-owned overlay above
 * the browser canvas and is never injected into the tested page; the Chrome
 * extension messaging layer is removed; the asset is inlined; a click pulse
 * was added. Cursor motion is presentation only — coordinates come from the
 * executor, and the animation must never gate or delay test execution.
 *
 * The engine lives in siblings of this file, which owns only the public
 * renderer: agent-cursor-geometry, -frame, -spring, -path, -path-score,
 * -motion, -state and -view. The notice above covers the adapted code in all
 * of them.
 */

import {
  MIN_FRAME_SECONDS,
  cancelCursorFrame,
  now,
  requestCursorFrame,
  type CursorFrameHandle,
} from "./agent-cursor-frame";
import type { AgentCursorPoint } from "./agent-cursor-geometry";
import { isCursorAnimating, stepCursor } from "./agent-cursor-motion";
import { applyCursorState, createCursorSession, type AgentCursorState } from "./agent-cursor-state";
import { applyCursorTransform, createCursorParts, spawnClickPulse } from "./agent-cursor-view";

export interface AgentCursorRenderer {
  setState(state: AgentCursorState): void;
  pulse(point: AgentCursorPoint): void;
  destroy(): void;
}

export function createAgentCursorRenderer(
  root: HTMLElement,
  options: { onArrived?: (moveSequence: number) => void } = {},
): AgentCursorRenderer {
  const parts = createCursorParts(root);
  const session = createCursorSession();
  let frameId: CursorFrameHandle | null = null;
  let previousTimestamp = now();
  let destroyed = false;

  const reportArrival = () => {
    if (
      session.activeMoveSequence == null ||
      session.activeArrivalKey == null ||
      session.reportedArrivalKey === session.activeArrivalKey
    ) {
      return;
    }
    session.reportedArrivalKey = session.activeArrivalKey;
    options.onArrived?.(session.activeMoveSequence);
  };

  const requestFrame = () => {
    if (frameId != null || session.model == null || destroyed) {
      return;
    }
    frameId = requestCursorFrame((timestamp) => {
      frameId = null;
      const current = session.model;
      if (!current) {
        return;
      }
      const deltaSeconds = session.forceFirstFrame
        ? MIN_FRAME_SECONDS
        : Math.max(MIN_FRAME_SECONDS, (timestamp - previousTimestamp) / 1000);
      session.forceFirstFrame = false;
      previousTimestamp = timestamp;
      const arrived = stepCursor(current, deltaSeconds, timestamp);
      applyCursorTransform(parts.cursor, current);
      if (arrived) {
        reportArrival();
      }
      if (isCursorAnimating(current)) {
        requestFrame();
      }
    });
  };

  return {
    destroy: () => {
      destroyed = true;
      if (frameId != null) {
        cancelCursorFrame(frameId);
        frameId = null;
      }
      parts.layer.replaceChildren();
    },
    pulse: (point) => {
      if (destroyed) {
        return;
      }
      spawnClickPulse(parts.layer, point);
    },
    setState: (state) => {
      if (destroyed) {
        return;
      }
      const { model, reportsArrival } = applyCursorState(session, state);
      applyCursorTransform(parts.cursor, model);
      if (reportsArrival) {
        reportArrival();
      }
      requestFrame();
    },
  };
}
