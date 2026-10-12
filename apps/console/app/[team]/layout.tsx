import type { ReactNode } from "react";

import { WorkspaceFrame } from "../_components/workspace-frame";
import { sessionBoundary } from "./_lib/frame-session";

/**
 * The frame every workspace page is drawn in, shared by the product's
 * sections and the team's, so moving between any of them — or to another
 * product — keeps it on screen instead of rebuilding it.
 *
 * It awaits nothing, so it is in the static shell a page load paints first:
 * the rail at full size, with placeholders where the session will fill it.
 * Its boundaries wait on the same session read as the head of a pending
 * page's column, so they are revealed together. React reveals streamed
 * boundaries in batches, the first no sooner than 300 ms after the shell
 * paints and each next one 300 ms after the last: a page ready before the
 * frame's batch is revealed with it, and one ready just after waits for the
 * next batch. Each page brings its own boundary, its skeleton and its column,
 * the top bar with it (WorkspacePage).
 */
export default function WorkspaceLayout({ children, params }: Readonly<{
  children: ReactNode;
  params: Promise<{ team: string }>;
}>) {
  return (
    <WorkspaceFrame withSession={sessionBoundary(params)}>{children}</WorkspaceFrame>
  );
}
