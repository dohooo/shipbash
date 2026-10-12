import type { ReactNode } from "react";

import { ColumnHead, PendingColumn, PendingHead } from "../../_components/workspace-shell";
import { sessionBoundary } from "./frame-session";

/**
 * What stands in a page's place until the page is ready: its skeleton in a
 * pending column. The column's head is a boundary of its own over the
 * session, so a page load streams the address's trail as soon as the session
 * is read, however long the page's own reads take. Before that, in the static
 * shell and in the browser, PendingHead holds its place.
 */
export function PageFallback({ params, children }: Readonly<{ params: Promise<{ team: string }>; children: ReactNode }>) {
  return (
    <PendingColumn head={sessionBoundary(params)(<ColumnHead />, <PendingHead />)}>{children}</PendingColumn>
  );
}
