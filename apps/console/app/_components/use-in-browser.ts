"use client";

import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

/**
 * Whether this render is the browser's own: false on the server and while the
 * browser adopts what the server drew, true from the render after that and in
 * everything the browser draws itself.
 */
export function useInBrowser(): boolean {
  return useSyncExternalStore(subscribeToNothing, () => true, () => false);
}
