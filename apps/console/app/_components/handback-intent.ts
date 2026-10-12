/**
 * Whether THIS tab just handed a takeover session back for a run.
 *
 * The resume itself is the server's (auth/complete re-dispatches the run); the
 * intent only recolors the run page's banner from "Sign-in needed" to "Control
 * handed back" while the resumed run spins up. Session storage matches the
 * takeover intent's scope: it survives the navigation back from the session
 * page and stays private to the tab that did the signing in. A stale timestamp
 * reads as no intent — an old handback must not repaint a NEW sign-in wall
 * green.
 */

const HANDBACK_FRESH_MS = 10 * 60 * 1_000;
const handbackPictures = new Map<string, string>();

function storageKey(runId: string): string {
  return `shipbash.handback.${runId}`;
}

export function setHandback(runId: string, picture?: string): void {
  if (typeof window === "undefined") return;
  if (picture) handbackPictures.set(runId, picture);
  try {
    window.sessionStorage.setItem(storageKey(runId), new Date().toISOString());
  } catch {
    // Private-mode browsers throw; the run still resumes, the banner just
    // stays on its amber wording until the run reports running.
  }
}

/**
 * This tab's transient picture bridges route navigation; it is never
 * persisted. It lives only as long as the handback intent: a stale or retired
 * handback must not lay its old picture over a new sign-in wall either.
 */
export function readHandbackPicture(runId: string): string | null {
  return readHandback(runId) === null ? null : handbackPictures.get(runId) ?? null;
}

export function clearHandbackPicture(runId: string): void {
  handbackPictures.delete(runId);
}

/** The stored handback timestamp, or null when absent or older than 10 minutes. */
export function readHandback(runId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.sessionStorage.getItem(storageKey(runId));
    if (!stored) return null;
    const at = Date.parse(stored);
    if (!Number.isFinite(at) || Date.now() - at > HANDBACK_FRESH_MS) return null;
    return stored;
  } catch {
    return null;
  }
}

export function clearHandback(runId: string): void {
  if (typeof window === "undefined") return;
  handbackPictures.delete(runId);
  try {
    window.sessionStorage.removeItem(storageKey(runId));
  } catch {
    // Same as above: persistence is a nicety, never a requirement.
  }
}
