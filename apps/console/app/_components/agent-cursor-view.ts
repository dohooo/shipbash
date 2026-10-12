/**
 * The cursor's DOM: the overlay layer, the arrow asset, the click pulse, and
 * the transform that composes one model pose. The transform composition and
 * the bundled asset are adapted from open-browser-use's content-cursor.js;
 * see agent-cursor-renderer.ts for the notice.
 */

import { now } from "./agent-cursor-frame";
import {
  MIN_SQUASH,
  clamp,
  lerp,
  normalizeDegrees,
  round,
  shortestAngleDelta,
  type AgentCursorPoint,
} from "./agent-cursor-geometry";
import { idleRotation, type CursorModel } from "./agent-cursor-motion";

const CURSOR_ASSET_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAwCAYAAABuZUjcAAAG+klEQVR4Ae1ZW2xUVRS982qnj+lzSh9UrLWosVFq+TAkRmpi0URJSBogqRggavyF1Cj6Q0P94A+iURJDQrH6Q2OxIF/EEE0a0hqBEBKRQihSIYHQxwzTTtuZua51e/Z4GeZxh85MP2AnJ/d1HuvsvfY++5yraU/kiTzeYtN1PVq6u7vtvPK9fNOWSZzxXhIQhFfjecuWLfa7d+/a+vr6GvB+bPPmzXpzc7O+WHWxLu+15RTRLG7tbW1tzps3b64OhUKDeD+pK8Hzb4FA4MNr166tZh2pLxaRCedaqD4Ccfl8vo/MgOOJTOLcuXNVaCOTiFIpJ3RSgxigL168+EIq0DEyOT8//919e/fa165d6wKdHCwm8FKyAtpG0zc0NLjn5uZ+EETXr1/X8d7gNL7pu3btMt4lkkgkMsZJTE1NvclJoJ2DljA5d2aBs2M4XZ7X6/Vg8CkBsmnTJgN0bGlpadF7e3tTTgJK6IE/PIc2hiW0RatmzAI21an75MmTa8yDxwMdW2gRTmJyMjG7Yp1aJhFDpfQmw8bsDLdFe/bsaTIPSHpYAS9lx44d+vHjx/VkIpMYGhpagTbGJOJQKfUkVANXdXV1Ea7V6PSsDIIO0wIuhRPmJM6cOZNsDpOgUp84tab8wWQFTU/mF6JxAi8uLl5x9erVfdIzB34U4LGTSNepJSppyTSvKjjq6+sLcPVu27btAZ5LVMlEserUpJKyQuJoxA+cYVNTUz4eywsKCp7CAjS8VLqkKqmcemZm5hNGOpP2HwIe5XlFRUVJYWFh3YULFz6LEhEdZwO4ZsGpYZlXCV5bDKPxtU6e19XVFYLnVZ2dnS3hcHg6G3TRUviDmUagzLeKwk7ReuwMCC4CbYedTucCZj8Bb/9VPmIh0nIhY2Nj2s6dO6PPbrf7nWAw6ATfJRONKzblEJ6ioqIaLEbvmelSVlaWM62LIOb/g3flTEVUEvcwZ8j1xsbGCG7DmF0YTnEWHu7jN4DWEBG0XAgsH70HXX0ej8cBSyQPixJdALSM0eXWrVu9MvtMxPRUhb5k5jjo2g/gXvoevjsSAtcWA76zqqqqGNfqU6dOdWaTLuyPYA8cOPBQbGdw2L9//2uoV4niVsATat7QOj25pKSkAs7xDJblcemMK+BSwcpKSgsmS8xGRkY+p9VpfXI8ocZFlBPkl5eXl6JhPfj11VLpkkir8QTL/h+HDh3qyM/Pf5ZWR/GooGFLCVxli8XMXXp6etrMHadLlyNHjiQFisjhu3Hjxi9QSveGDRteR5tmgobSVoq2VRqcHLiunJQNFF0apqenR2SgdFIAajqeTExM/Hnp0qXvjh49+rHL5WpF3ZdRXkRpwnhP41pD0HRKpcQoaHsi4Az0PIKorKwMOxwOhsYFRJfT8n39+vWaVdm+fXv03u/3j0Kr+9rb299AavFBa2vr1/j+u91u9wGsH1WmsX748/Ly/NiJBUCZYG1t7QIXRkuD6WqTK5sL0oUpgFljVlMAM6cHBwe7AOol0OB5xd9VzIvYP0JeJX2K0YyBQVJbLU52mEzjHJQLQQR0odYXBgYGJqGxEaljXiQSCdoaReTw4cND0G4A5T4ila+0tNQPTd+HlgOwbgARJghLB9etWze/cePG8LFjx6jpiOCxJPr/xxXGBhrXuvPnz38q2rOSMTLjE6GPKC3XULPctHCho2Zj96D6Uk8DVAekSyFXr46OjlfSyRjN27bLly9/iXcroWUj7xCw+oNnL5kR0ToH4oAIT6vu3LkzIGAOHjyYFLhZED3eZbqs9rVGTNazeVzHmE5zki5wpFqrGaM5DHLlZUgVbVuKyRmQ6AaDng8AjVboYl50YKWfuJjgfQmKsZtZCo/tFuvpCFE6NxiIKiEk9Qu3b9/+WT7u3bs3biNz1Lly5crp2dnZEG7DmqJQWpHiUUTx0NA6Yyw3GOaMkRJ7aMSdvFm2bt26Bu+9sgXTckATAW84qRqYdGnADvwvAcZFhmeMcghkXnR4WiAZnjpFsGrpjADnxa5228wYV544ceJ93YLAudtgpWpay1KGlwXw0RQApYpOOjo6+k0iwMz4hoeHv2DCxEQNbWitnESTWDFOu6h1mh33dVgJV+/evfttOOsgHPdvgoXz/guq/NjV1fUW6jSh1KB4SBPZ7GYCSNptoHUHokQessV8RJoChMZCKDgP535OpKc2FS1CeJ7DdRZznEEJgv8hrKThTEQTp5a+GGcv0O4CH+Cg3K2EwXkXKMH+qFEdWmfomwPgeayWc9hBhWCFcNZDYAqxmXZIbjodkybFYy+vkp5qixtcmVDGuP3IHcmqBw0avwrBXzv4bWMZHx+XJT/Mhau/v5/P1jYCuRLd9NcZjw7572n657lsf5/TlZyA/Q9N3TljZhaAsAAAAABJRU5ErkJggg==";

const CURSOR_SIZE = 24;
const CURSOR_CENTER = CURSOR_SIZE / 2;
const IMAGE_WIDTH = 23;
const IMAGE_HEIGHT = 24;
const IMAGE_OFFSET_X = 12;
const IMAGE_OFFSET_Y = -2.5;
const IMAGE_ROTATION = 44;
const VISIBILITY_SCALE_MIN = 0.4;
const VISIBILITY_BLUR_MAX = 5;
const PULSE_DURATION_MS = 480;

export function createCursorParts(root: HTMLElement): { cursor: HTMLElement; layer: HTMLElement } {
  root.replaceChildren();
  root.setAttribute("aria-hidden", "true");
  root.style.inset = "0";
  root.style.overflow = "hidden";
  root.style.pointerEvents = "none";
  root.style.position = "absolute";
  root.style.zIndex = "10";

  const cursor = document.createElement("div");
  cursor.dataset.testid = "agent-cursor";
  cursor.style.height = `${CURSOR_SIZE}px`;
  cursor.style.left = "0";
  cursor.style.position = "absolute";
  cursor.style.top = "0";
  cursor.style.transform = "translate3d(-9999px, -9999px, 0)";
  cursor.style.transformOrigin = `${CURSOR_CENTER}px ${CURSOR_CENTER}px`;
  cursor.style.willChange = "transform, opacity, filter";
  cursor.style.width = `${CURSOR_SIZE}px`;

  const assetWrap = document.createElement("div");
  assetWrap.style.transform = `translate3d(${IMAGE_OFFSET_X}px, ${IMAGE_OFFSET_Y}px, 0)`;

  const image = document.createElement("img");
  image.alt = "";
  image.dataset.testid = "agent-cursor-asset";
  image.draggable = false;
  image.height = IMAGE_HEIGHT;
  image.src = CURSOR_ASSET_DATA_URI;
  image.style.display = "block";
  image.style.transform = `rotate(${IMAGE_ROTATION}deg) scale(1)`;
  image.style.transformOrigin = "0 0";
  image.width = IMAGE_WIDTH;

  assetWrap.appendChild(image);
  cursor.appendChild(assetWrap);
  root.appendChild(cursor);
  return { cursor, layer: root };
}

export function spawnClickPulse(layer: HTMLElement, point: AgentCursorPoint): void {
  const pulse = document.createElement("div");
  pulse.dataset.testid = "agent-cursor-pulse";
  pulse.style.border = "2px solid rgba(37, 99, 235, 0.85)";
  pulse.style.borderRadius = "9999px";
  pulse.style.height = "28px";
  pulse.style.left = `${point.x - 14}px`;
  pulse.style.opacity = "0.9";
  pulse.style.pointerEvents = "none";
  pulse.style.position = "absolute";
  pulse.style.top = `${point.y - 14}px`;
  pulse.style.transform = "scale(0.35)";
  pulse.style.width = "28px";
  layer.appendChild(pulse);
  const remove = () => pulse.remove();
  const animation = typeof pulse.animate === "function"
    ? pulse.animate(
        [
          { opacity: 0.9, transform: "scale(0.35)" },
          { opacity: 0, transform: "scale(1.55)" },
        ],
        { duration: PULSE_DURATION_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      )
    : null;
  if (animation) {
    animation.addEventListener("finish", remove, { once: true });
    animation.addEventListener("cancel", remove, { once: true });
  } else {
    window.setTimeout(remove, PULSE_DURATION_MS);
  }
}

export function applyCursorTransform(cursor: HTMLElement, model: CursorModel): void {
  const transform = computeCursorTransform({
    point: model.point,
    rotation: idleRotation(model, now()),
    scootAxisRotation: model.scootAxisRotation,
    scootRotation: model.scootRotationSpring.value,
    scootStretch: model.scootStretchSpring.value,
    stretch: model.stretchSpring.value,
    visibility: model.visibilitySpring.value,
  });
  cursor.style.transform = transform.transform;
  cursor.style.opacity = `${transform.opacity}`;
  cursor.style.filter = transform.filter;
}

function computeCursorTransform({
  point,
  rotation,
  scootAxisRotation,
  scootRotation,
  scootStretch,
  stretch,
  visibility,
}: {
  point: AgentCursorPoint;
  rotation: number;
  scootAxisRotation: number;
  scootRotation: number;
  scootStretch: number;
  stretch: number;
  visibility: number;
}): { filter: string; opacity: number; transform: string } {
  const opacity = clamp(visibility, 0, 1);
  const visibilityScale = lerp(VISIBILITY_SCALE_MIN, 1, opacity);
  const blur = lerp(VISIBILITY_BLUR_MAX, 0, opacity);
  const verticalStretch = clamp(scootStretch, MIN_SQUASH, 1);
  const transforms = [
    `translate3d(${round(point.x - CURSOR_CENTER)}px, ${round(point.y - CURSOR_CENTER)}px, 0)`,
  ];
  if (Math.abs(shortestAngleDelta(0, scootAxisRotation)) > 0.001 || Math.abs(verticalStretch - 1) > 0.001) {
    transforms.push(
      `rotate(${round(scootAxisRotation)}deg)`,
      `scale(1, ${round(verticalStretch)})`,
      `rotate(${round(-scootAxisRotation)}deg)`,
    );
  }
  transforms.push(
    `rotate(${round(normalizeDegrees(rotation + scootRotation))}deg)`,
    `scale(${round(stretch * visibilityScale)}, ${round(visibilityScale)})`,
  );
  return {
    filter: `blur(${round(blur)}px)`,
    opacity: round(opacity),
    transform: transforms.join(" "),
  };
}
