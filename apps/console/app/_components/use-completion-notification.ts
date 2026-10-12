"use client";

import { useEffect, useRef } from "react";

/**
 * Fires a browser notification when a watched run finishes while the tab is
 * hidden. Permission is requested once while the run is active, so the ask
 * appears in a context where the user understands why.
 */
export function useCompletionNotification(active: boolean, title: string, body: string) {
  const wasActive = useRef(false);

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (active && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    if (wasActive.current && !active && Notification.permission === "granted" && document.hidden) {
      try {
        const notification = new Notification(title, { body, icon: "/shipbash-eye-192.png" });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
      } catch {
        // Notifications are best-effort; some browsers require a service worker.
      }
    }
    wasActive.current = active;
  }, [active, body, title]);
}
