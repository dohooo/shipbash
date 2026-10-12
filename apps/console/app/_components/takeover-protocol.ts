/**
 * What the takeover puts on the stream.
 *
 * The send seam every lane writes to, and the modifier bitmask both the mouse
 * and the keyboard carry, live here so the two lanes share them without
 * either one importing the other.
 */

export type TakeoverSend = (message: Record<string, unknown>) => void;

/** CDP modifier bitmask; the host's Cmd normalizes to the remote's Control. */
export function remoteModifiers(event: MouseEvent | KeyboardEvent): number {
  return (event.altKey ? 1 : 0)
    | (event.ctrlKey || event.metaKey ? 2 : 0)
    | (event.shiftKey ? 8 : 0);
}
