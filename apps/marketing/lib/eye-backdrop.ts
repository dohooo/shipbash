/**
 * The brand eye drifting behind a page: three rings drawn on a canvas, sized
 * to it, in whatever ink the page is set in. The marketing site and the
 * console's sign-in doors draw it with this, once per animation frame.
 */
function points(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  amplitude: number,
  lobes: number,
  time: number,
  seed: number,
) {
  const result: Array<readonly [number, number]> = [];
  for (let index = 0; index <= 90; index += 1) {
    const angle = (index / 90) * Math.PI * 2;
    const wave = 1
      + amplitude * Math.sin(lobes * angle + seed + time * 0.5)
      + amplitude * 0.45 * Math.sin((lobes + 2) * angle + seed * 2.3 - time * 0.36);
    result.push([
      centerX + radiusX * wave * Math.cos(angle),
      centerY + radiusY * wave * Math.sin(angle),
    ]);
  }
  return result;
}

function stroke(context: CanvasRenderingContext2D, path: Array<readonly [number, number]>) {
  context.beginPath();
  for (const [index, point] of path.entries()) {
    if (index === 0) context.moveTo(point[0], point[1]);
    else context.lineTo(point[0], point[1]);
  }
  context.stroke();
}

/** One frame of the backdrop at `time` seconds, the canvas resized to its box first. */
export function drawEyeBackdrop(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  ink: string,
  time: number,
) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = ink;
  const centerX = 0.82 * width;
  const centerY = 0.18 * height;
  const base = Math.min(width, height) * 0.72 * (1 + 0.02 * Math.sin(time * 0.4));
  context.lineWidth = 18;
  context.globalAlpha = 0.06;
  stroke(context, points(centerX, centerY, base * 1.3, base, 0.05, 5, time, 0.7));
  context.lineWidth = 11;
  context.globalAlpha = 0.045;
  stroke(context, points(centerX, centerY, base * 0.92, base * 0.68, 0.06, 5, time * 1.15, 3.9));
  context.lineWidth = 6;
  context.globalAlpha = 0.04;
  stroke(context, points(centerX, centerY, base * 0.58, base * 0.42, 0.06, 4, time * 1.3, 7.2));
  context.globalAlpha = 1;
}
