"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { safeBrowserViewerUrl } from "../../lib/client-contracts";

const SNAPSHOT_LIMIT = 6_000_000;
const FREEZE_TIMEOUT_MS = 2_000;

interface ViewerSession {
  frame: HTMLIFrameElement;
  origin: string;
  lease: string;
  nonce: string;
  ready: boolean;
  enabled: boolean;
  allowEnable: boolean;
  snapshot: ((value: string | null) => void) | null;
}

function viewerAddress(value: string): { src: string; origin: string; lease: string } | null {
  try {
    const safe = safeBrowserViewerUrl(value);
    if (!safe) return null;
    const url = new URL(safe);
    const lease = new URLSearchParams(url.hash.slice(1)).get("password");
    if (!lease) return null;
    url.searchParams.set("shipbash_parent_origin", window.location.origin);
    return { src: url.href, origin: url.origin, lease };
  } catch { return null; }
}

function validSnapshot(value: unknown): value is string {
  return typeof value === "string" && value.length < SNAPSHOT_LIMIT
    && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value);
}

function viewerMessage(event: MessageEvent, session: ViewerSession): Record<string, unknown> | null {
  if (event.source !== session.frame.contentWindow || event.origin !== session.origin) return null;
  const parsed = z.record(z.string(), z.unknown()).safeParse(event.data);
  if (!parsed.success || Array.isArray(event.data)) return null;
  const message = parsed.data;
  return Object.keys(message).length <= 4 && typeof message.type === "string" ? message : null;
}

function applyControlReport(options: {
  message: Record<string, unknown>;
  session: ViewerSession;
  post: (type: string) => void;
  setEnabled: (value: boolean) => void;
  setError: (value: string) => void;
  retry: number;
}): boolean {
  const { message, session, post, setEnabled, setError, retry } = options;
  if (message.type === "shipbash-novnc-ready" && session.allowEnable) {
    session.ready = true;
    post("shipbash-novnc-enable");
    return true;
  }
  if (message.type === "shipbash-novnc-enabled" && session.allowEnable && session.ready) {
    session.enabled = true;
    setEnabled(true);
    window.clearInterval(retry);
    return true;
  }
  // A drop, or a fall back to connecting once the lease was live, retires the
  // lease; the first connecting before any frame is only the wait for one.
  if (message.type === "shipbash-novnc-state"
    && (message.state === "disconnected" || message.state === "connecting")) {
    if (message.state === "disconnected" || session.ready || session.enabled) {
      session.ready = false;
      session.enabled = false;
      session.allowEnable = false;
      setEnabled(false);
      setError("The private browser disconnected. Retry to regain control.");
      window.clearInterval(retry);
    }
    return true;
  }
  return false;
}

/** A current noVNC lease becomes interactive only after its remote frame was painted. */
export function useNoVncControl(viewerUrl: string | null) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sessionRef = useRef<ViewerSession | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const post = useCallback((type: string) => {
    const session = sessionRef.current;
    if (!session?.frame.isConnected) return;
    session.frame.contentWindow?.postMessage({ type, nonce: session.nonce, lease: session.lease }, session.origin);
  }, []);

  // A new epoch deliberately retires the old nonce and remounts the lease.
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch is an explicit session reset key.
  useEffect(() => {
    const frame = frameRef.current;
    const address = viewerUrl ? viewerAddress(viewerUrl) : null;
    setEnabled(false);
    setError(null);
    if (!frame || !address) return;
    const session: ViewerSession = {
      frame, origin: address.origin, lease: address.lease, nonce: crypto.randomUUID(),
      ready: false, enabled: false, allowEnable: true, snapshot: null,
    };
    sessionRef.current = session;
    const authorize = () => frame.contentWindow?.postMessage({
      type: "shipbash-novnc-authorize", nonce: session.nonce, lease: session.lease,
    }, session.origin);
    const onMessage = (event: MessageEvent) => {
      if (sessionRef.current !== session) return;
      const message = viewerMessage(event, session);
      if (!message) return;
      if (message.type === "shipbash-novnc-hello" && message.protocol === 1) { authorize(); return; }
      if (message.nonce !== session.nonce) return;
      if (applyControlReport({ message, session, post, setEnabled, setError, retry })) return;
      if (message.type === "shipbash-novnc-snapshot" && validSnapshot(message.snapshot)) {
        session.snapshot?.(message.snapshot);
        session.snapshot = null;
      } else if (message.type === "shipbash-novnc-error") {
        session.snapshot?.(null);
        session.snapshot = null;
        setError("The browser picture could not be saved. Retry the handoff.");
      }
    };
    window.addEventListener("message", onMessage);
    frame.addEventListener("load", authorize);
    frame.src = address.src;
    const retry = window.setInterval(() => { if (session.allowEnable && !session.enabled) authorize(); }, 750);
    return () => {
      post("shipbash-novnc-revoke");
      session.snapshot?.(null);
      if (sessionRef.current === session) sessionRef.current = null;
      window.clearInterval(retry);
      frame.removeEventListener("load", authorize);
      window.removeEventListener("message", onMessage);
      frame.removeAttribute("src");
    };
  }, [epoch, post, viewerUrl]);

  const freeze = useCallback(async (): Promise<string | null> => {
    const session = sessionRef.current;
    if (!session?.enabled) return null;
    session.enabled = false;
    session.allowEnable = false;
    session.ready = false;
    setEnabled(false);
    const snapshot = await new Promise<string | null>((resolve) => {
      const timer = window.setTimeout(() => { session.snapshot = null; resolve(null); }, FREEZE_TIMEOUT_MS);
      session.snapshot = (value) => { window.clearTimeout(timer); resolve(value); };
      post("shipbash-novnc-freeze");
    });
    if (!snapshot) return null;
    const image = new Image();
    image.src = snapshot;
    try {
      await image.decode();
      return sessionRef.current === session ? snapshot : null;
    } catch { return null; }
  }, [post]);

  const restart = useCallback(() => setEpoch((current) => current + 1), []);
  return { frameRef, enabled, error, freeze, post, restart };
}
