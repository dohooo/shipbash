/** Browser identity and the last frame actually painted for this viewer. */
export type BrowserSourceKey = string;

export interface PaintedBrowserFrame {
  sourceKey: BrowserSourceKey;
  generation: number;
  sequence: number;
  tabId: string | null;
  url: string;
  title: string;
}

export interface BrowserPresentation {
  sourceKey: BrowserSourceKey;
  transportConnected: boolean;
  sourceConnected: boolean;
  displayed: PaintedBrowserFrame | null;
  ready: boolean;
}

/** Whether a painted frame came after `before`: another source, or a later frame of the same one. */
export function newerFrame(current: PaintedBrowserFrame, before: PaintedBrowserFrame | null): boolean {
  return !before || current.sourceKey !== before.sourceKey
    || current.generation > before.generation
    || (current.generation === before.generation && current.sequence > before.sequence);
}

/** Only the sidecar's opaque identity is accepted; endpoint URLs stay private. */
export function browserSourceKey(message: Record<string, unknown>): BrowserSourceKey | null {
  const key = message.sourceKey;
  return typeof key === "string" && key.length > 0 && key.length <= 128 ? key : null;
}

/** The frame's own page metadata, captured at the same time as its pixels. */
export function paintedBrowserFrame(message: Record<string, unknown>): PaintedBrowserFrame | null {
  const sourceKey = browserSourceKey(message);
  const generation = message.generation;
  const sequence = message.sequence;
  if (!sourceKey || typeof message.url !== "string" || !message.url
    || typeof message.title !== "string"
    || typeof generation !== "number" || typeof sequence !== "number"
    || !Number.isSafeInteger(generation) || !Number.isSafeInteger(sequence)
    || generation < 0 || sequence < 0) return null;
  return {
    sourceKey,
    generation,
    sequence,
    tabId: typeof message.tabId === "string" ? message.tabId : null,
    url: message.url,
    title: message.title,
  };
}
