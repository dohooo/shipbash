"use client";

import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { failedRead, type ReadFailure } from "../_lib/request-errors";
import { QueryError } from "./query-error";
import { useInBrowser } from "./use-in-browser";

/**
 * A route's "try again". The queries that failed are first allowed to fetch
 * again — a suspense query that threw stays failed until its boundary is
 * reset — and then Next re-reads the segment, the server's prefetch with it.
 */
export function useRouteRetry(retry: () => void): () => void {
  const { reset } = useQueryErrorResetBoundary();
  return () => {
    reset();
    retry();
  };
}

/** What an `error.tsx` draws: the workspace's own error, with its recoveries. */
export function RouteError({ error, retry }: Readonly<{ error: Error; retry: () => void }>) {
  return (
    <div className="page">
      <QueryError error={error} retry={useRouteRetry(retry)} />
    </div>
  );
}

/**
 * A read the server could not make, thrown to the route's `error.tsx` once
 * the page is in the browser; until then the page's skeleton stands.
 *
 * Not thrown on the server: in production a server error reaches the browser
 * as a bare message, and the recoveries (a sign-out on AUTHENTICATION_REQUIRED,
 * a scope reset on TEAM_NOT_FOUND) need the service's answer. Not drawn on the server either:
 * those recoveries decide in the browser, so a server-drawn error would not
 * match what the browser draws. `null` is any other failure, whose message is
 * not the reader's to see.
 */
export function ServerReadError({ failure, fallback }: Readonly<{ failure: ReadFailure | null; fallback: ReactNode }>) {
  const inBrowser = useInBrowser();
  if (!inBrowser) return fallback;
  throw failedRead(failure);
}
