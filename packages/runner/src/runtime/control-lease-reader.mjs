// The takeover control lease, shared by every lane whose screencast sidecar
// gates viewer input on it. The server mints a token into a bind-mounted
// control directory and removes it when the takeover ends, so control dies
// with the session and a lane whose mount carries no lease can never be
// driven by a viewer at all.
import { readFile } from "node:fs/promises";

/**
 * How long one read is reused. Mouse moves arrive far faster than the lease
 * changes, and the file lives on a bind mount.
 */
export const CONTROL_LEASE_CACHE_MS = 500;

/**
 * Reader for the control-lease token at `leasePath`, or null when no takeover
 * is active. A missing, unreadable or blank file all read as no lease.
 * @param {string} leasePath
 * @returns {() => Promise<string | null>}
 */
export function createControlLeaseReader(leasePath) {
  let cached = { value: /** @type {string | null} */ (null), readAt: 0 };
  return async () => {
    if (Date.now() - cached.readAt < CONTROL_LEASE_CACHE_MS) return cached.value;
    const value = await readFile(leasePath, "utf8")
      .then((content) => content.trim() || null)
      .catch(() => null);
    cached = { value, readAt: Date.now() };
    return value;
  };
}
