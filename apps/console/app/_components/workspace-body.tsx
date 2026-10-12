"use client";

import type { ReactNode } from "react";

import { resolvedWorkspace, useRouteScope, useRouteSession, WorkspaceProvider } from "./workspace-session";
import { PageColumn } from "./workspace-shell";

/**
 * The workspace a page is drawn in: the team and product the address names, as
 * the session grants them. It sits inside the page's boundary, so the session
 * it reads was answered on the server with the page's own reads. It is drawn
 * only over a session the server read: a failure goes to the route's error
 * view instead (see ServerReadError). The page draws its own column; a
 * session with no Team is said in one of the workspace's, or in the layout's
 * a page is drawn in.
 */
export function WorkspaceBody({ inLayoutColumn, children }: Readonly<{
  /** The page is drawn in its layout's column, which then holds the state. */
  inLayoutColumn?: true | undefined;
  children: ReactNode;
}>) {
  const scope = useRouteScope();
  const session = useRouteSession();
  const workspace = resolvedWorkspace(session, scope);
  if (!workspace) {
    const state = <div className="state">No Team is available.</div>;
    return inLayoutColumn ? state : <PageColumn>{state}</PageColumn>;
  }
  return <WorkspaceProvider value={workspace}>{children}</WorkspaceProvider>;
}
