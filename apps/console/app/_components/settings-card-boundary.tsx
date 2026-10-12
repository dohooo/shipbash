"use client";

import { catchError } from "next/error";

import { QueryError } from "./query-error";
import { useRouteRetry } from "./route-error";

function CardError({ error, retry }: Readonly<{ error: unknown; retry: () => void }>) {
  return (
    <section className="settings-card">
      <QueryError error={error} retry={useRouteRetry(retry)} />
    </section>
  );
}

/**
 * A part of Settings whose read fails in the browser — one the server did not
 * read for the pane — without taking the rest of the page with it: the part
 * becomes a card with the workspace's error and the page's own retry, and the
 * title, the column and every other card stay. A read the server made and
 * could not answer is the route's error instead (WorkspacePage). Loading is
 * not caught here: a suspended read still reaches the page's one placeholder.
 */
export const SettingsCardBoundary = catchError((_props: Record<never, never>, { error, retry }) => (
  <CardError error={error} retry={retry} />
));
