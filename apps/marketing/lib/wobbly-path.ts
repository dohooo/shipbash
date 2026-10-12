export function wobblyPath(
  baseRadius: number,
  amplitude: number,
  lobes: number,
  time: number,
  seed: number,
  rotation = 0,
  samples = 120,
): string {
  const center = 200;
  const points: Array<readonly [number, number]> = [];
  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * Math.PI * 2 + rotation;
    const radius = baseRadius * (
      1
      + amplitude * Math.sin(lobes * angle + seed + time * 0.55)
      + amplitude * 0.45 * Math.sin((lobes + 2) * angle + seed * 2.3 - time * 0.38)
      + amplitude * 0.2 * Math.sin(3 * angle + seed * 4.1 + time * 0.27)
    );
    points.push([
      center + radius * Math.cos(angle),
      center + radius * Math.sin(angle),
    ]);
  }

  let path = "";
  for (const [index, current] of points.entries()) {
    const previous = points[(index - 1 + samples) % samples] ?? current;
    const next = points[(index + 1) % samples] ?? current;
    const after = points[(index + 2) % samples] ?? current;
    if (index === 0) path = `M ${current[0].toFixed(1)} ${current[1].toFixed(1)}`;
    path += ` C ${(current[0] + (next[0] - previous[0]) / 6).toFixed(1)} ${(current[1] + (next[1] - previous[1]) / 6).toFixed(1)}, ${(next[0] - (after[0] - current[0]) / 6).toFixed(1)} ${(next[1] - (after[1] - current[1]) / 6).toFixed(1)}, ${next[0].toFixed(1)} ${next[1].toFixed(1)}`;
  }
  return `${path} Z`;
}

export function staticEyePaths(wobble = 1.5, coreWobble = 0.5, lobes = 5) {
  const time = 2.4;
  return {
    outer: wobblyPath(146, 0.052 * wobble, lobes, time, 0.7),
    inner: wobblyPath(84, 0.07 * wobble, lobes, time * 1.15, 3.9),
    ring: wobblyPath(46, 0.06 * coreWobble, 4, time * 1.5, 7.2),
    dot: wobblyPath(17, 0.08 * coreWobble, 3, time * 1.8, 11.5),
  };
}
