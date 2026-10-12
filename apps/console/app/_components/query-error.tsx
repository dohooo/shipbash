"use client";

/**
 * How a failed workspace query reaches the reader: an actionable error, or one
 * of two recoveries under way (lib/session-recovery.ts) — a scope reset when
 * the address no longer names a team the session can see, a sign-out when the
 * session itself is gone.
 */
import { useLayoutEffect, useState, type ReactNode } from "react";

import { recover, recoveryFor } from "../../lib/session-recovery";
import { apiMessage } from "../_lib/request-errors";

export function QueryError({ error, retry, action }: {
  error: unknown;
  retry: () => void;
  action?: ReactNode;
}) {
  // The recovery under way. A failed read has usually started it already
  // (makeQueryClient). A read the server could not make reaches the browser as
  // a thrown error, not a query, so the error view starts it too: once the
  // error is committed, not while drawing it, because an error boundary can
  // draw its fallback more than once before one is kept. A layout effect, so a
  // reset already spent shows the error without a frame of "recovering".
  const [recovery, setRecovery] = useState(() => recoveryFor(error));
  useLayoutEffect(() => {
    setRecovery(recover(error));
  }, [error]);
  if (recovery !== null) {
    return (
      <div className="state" role="status">
        <strong>{recovery === "sign_out" ? "Session expired" : "Workspace changed"}</strong>
        <p>{recovery === "sign_out" ? "Taking you back to sign in…" : "Loading your workspace…"}</p>
      </div>
    );
  }
  return (
    <div className="state" role="alert">
      <strong>Couldn&apos;t load this view</strong>
      <p>{apiMessage(error, "ShipBash could not load this view.")}</p>
      <div className="actions-row">
        <button className="button" type="button" onClick={retry}>Try again</button>
        {action}
      </div>
    </div>
  );
}
