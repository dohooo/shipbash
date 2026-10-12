"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Whether THIS tab is the one holding a takeover.
 *
 * The control lease lives on the server and survives a page reload; the
 * intent is kept in session storage because component state would not: the
 * viewer would drop back to "Take control" while the runner still considered
 * the takeover open. Session storage is exactly the right scope — it survives a reload and
 * is private to the tab, so restoring the intent can never make a second
 * viewer silently seize control from the person already signing in.
 */

function storageKey(activityId: string): string {
  return `shipbash.takeover.${activityId}`;
}

function readIntent(activityId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(storageKey(activityId)) === "1";
  } catch {
    // Private-mode and storage-partitioned browsers throw; the takeover still
    // works, it just will not survive a reload.
    return false;
  }
}

function writeIntent(activityId: string, requested: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (requested) window.sessionStorage.setItem(storageKey(activityId), "1");
    else window.sessionStorage.removeItem(storageKey(activityId));
  } catch {
    // Same as above: persistence is a nicety, never a requirement.
  }
}

export function useTakeoverIntent(
  activityId: string,
  /**
   * Whether the run can still be taken over — `undefined` while that is not
   * known yet. The distinction is the whole fix: a first paint happens before
   * the run has loaded, and treating "not loaded" as "not possible" wipes the
   * intent a reload just restored.
   */
  takeoverPossible: boolean | undefined,
): [boolean, (requested: boolean) => void] {
  // Server-rendered first paint must match the client's, so the stored value
  // is adopted in an effect rather than in the initial state.
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (readIntent(activityId)) setRequested(true);
  }, [activityId]);

  useEffect(() => {
    if (takeoverPossible !== false) return;
    writeIntent(activityId, false);
    setRequested(false);
  }, [activityId, takeoverPossible]);

  const update = useCallback((next: boolean) => {
    writeIntent(activityId, next);
    setRequested(next);
  }, [activityId]);

  return [requested, update];
}
