"use client";

import { RouteError } from "../_components/route-error";
import { Topbar } from "../_components/topbar";
import { PageColumn } from "../_components/workspace-shell";

/**
 * A workspace page that could not load, reported inside the frame so the rail
 * stays usable. It stands in for the page's whole column, so the bar over it
 * is the address's trail with each held place given its word, and none of the
 * page's actions.
 */
export default function WorkspaceError({ error, retry }: Readonly<{ error: Error & { digest?: string }; retry: () => void }>) {
  return <PageColumn topbar={<Topbar settled />}><RouteError error={error} retry={retry} /></PageColumn>;
}
