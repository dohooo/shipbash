export type AttentionSurface = "browser" | "terminal";

/** One moment the agent's attention landed on a surface, on the video timeline. */
export interface AttentionPoint {
  atMs: number;
  surface: AttentionSurface;
  /** The terminal session the point belongs to, or null on the browser. */
  sessionId?: string | null | undefined;
  /** What the agent ran or drove there, for a progress-bar marker. */
  label?: string | null | undefined;
}

export interface AttentionSegment {
  startMs: number;
  endMs: number;
  surface: AttentionSurface;
  sessionId: string | null;
  label: string | null;
}

export declare function surfaceForTool(tool: unknown): AttentionSurface | null;
export declare function isBackgroundSession(sessionId: unknown): boolean;
export declare function isBackgroundTerminalCall(args: unknown): boolean;
export declare function attentionSurfaceAt(track: unknown, atMs: number): AttentionSurface;
export declare function attentionShellAt(track: readonly AttentionPoint[], atMs: number): string | null;
export declare function attentionSegments(
  track: unknown,
  durationMs: number,
): AttentionSegment[];
