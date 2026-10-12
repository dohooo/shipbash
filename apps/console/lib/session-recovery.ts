import { ApiError } from "./api-client";

/**
 * What a failed request says about the reader's session: it is gone, so the
 * reader signs in again, or the address names a team the session cannot see,
 * so the workspace is read again from "/".
 */
type Recovery = "sign_out" | "reset_scope";

/**
 * Read from the service's code, never from a bare 401. The service answers a
 * session it cannot use with AUTHENTICATION_REQUIRED (the actor envelope).
 * Another 401 the browser can meet refuses another credential, a CLI token,
 * and leaves the session alone.
 */
export function recoveryFor(error: unknown): Recovery | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "TEAM_NOT_FOUND") return "reset_scope";
  if (error.code === "TEAM_REQUIRED" || error.code === "AUTHENTICATION_REQUIRED") return "sign_out";
  return null;
}

// A recovery that reloads the page must never chain: if the reset itself lands
// on a view that fails again, looping "/" → error → "/" turns one mismatch into
// an endless refresh. One attempt per session; after that the error is shown.
const SCOPE_RESET_FLAG = "shipbash-scope-reset";

function scopeResetAllowed(): boolean {
  try {
    if (window.sessionStorage.getItem(SCOPE_RESET_FLAG)) return false;
    window.sessionStorage.setItem(SCOPE_RESET_FLAG, "1");
    return true;
  } catch {
    return false;
  }
}

export function clearScopeResetFlag(): void {
  try {
    window.sessionStorage.removeItem(SCOPE_RESET_FLAG);
  } catch {
    // Storage being unavailable already disabled the recovery path.
  }
}

/** The recovery this page has started. Both leave the page, so there is at most one. */
let underWay: Recovery | null = null;

/**
 * Starts the recovery a failed request calls for, once per page, and returns
 * the one under way: null when the error calls for none, or when this
 * session's one scope reset is spent. Every failed read and write in the
 * browser comes here (makeQueryClient), a poll of a page already on screen
 * included, and so does the error view (QueryError) for a read the server
 * could not make, which reaches the browser as a thrown error rather than a
 * query. A poll that keeps failing after the session ended does not sign the
 * reader out twice.
 */
export function recover(error: unknown): Recovery | null {
  const recovery = recoveryFor(error);
  if (recovery === null) return null;
  if (underWay !== null) return underWay;
  if (recovery === "reset_scope" && !scopeResetAllowed()) return null;
  underWay = recovery;
  if (recovery === "reset_scope") {
    window.location.replace("/");
  } else {
    void fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
      .finally(() => window.location.assign("/login"));
  }
  return recovery;
}
