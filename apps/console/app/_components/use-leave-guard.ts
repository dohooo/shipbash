"use client";

import { useEffect } from "react";

/**
 * Holding the reader on a page that is in the middle of something losable.
 *
 * The App Router has no route guard of its own, so leaving is caught where the
 * two ways of leaving actually happen: the tab closing, and a link inside the
 * page being followed. It is deliberately narrow — a guard that fires on every
 * state is a door the reader learns to push through without reading.
 */
export function useLeaveGuard({ active, message }: { active: boolean; message: string }): void {
  useEffect(() => {
    if (!active) return;
    const holdUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = message;
    };
    const holdLink = (event: MouseEvent) => {
      // A modified click opens a second tab and leaves this one alone, so
      // there is nothing to hold; a click already refused is not ours to undo.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === "_blank") return;
      if (target.origin !== window.location.origin) return;
      if (window.confirm(message)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("beforeunload", holdUnload);
    // Capture, so the router's own handler never sees a click the reader took back.
    document.addEventListener("click", holdLink, true);
    return () => {
      window.removeEventListener("beforeunload", holdUnload);
      document.removeEventListener("click", holdLink, true);
    };
  }, [active, message]);
}
