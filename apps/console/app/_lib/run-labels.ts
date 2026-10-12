export function diagnosticArtifactWarningLabel(count: number): string {
  return `${count} diagnostic artifact${count === 1 ? "" : "s"} unavailable`;
}

/**
 * How long one settled walk took, for the rail's own status line. Seconds are
 * zero-padded past the first minute so the right-aligned column lines up with
 * `font-variant-numeric: tabular-nums`. A walk that has not both started and
 * finished has nothing to say, and says nothing.
 */
export function caseTookLabel(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const totalSeconds = Math.max(0, Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(seconds).padStart(2, "0")}s` : `${String(seconds)}s`;
}

export function runElapsedLabel(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "0s";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - new Date(startedAt).getTime()) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours)}h ${String(minutes)}m`
    : minutes > 0
      ? `${String(minutes)}m ${String(seconds)}s`
      : `${String(seconds)}s`;
}
