import type { ReactNode } from "react";

import { MobileLayers } from "./mobile-layers";
import {
  NavigationPlaceholder,
  RouteNavigation,
  UserPlaceholder,
  UserSlot,
  WorkspaceAddress,
} from "./workspace-shell";
import { ProjectSlot, SwitcherPlaceholder } from "./workspace-switcher";
import { RunLimitBar } from "./run-limit-bar";

/**
 * The frame every workspace page is drawn in: the rail, and beside it the
 * column each page draws (PageColumn), under the bar that says the month's
 * Runs are used. On a phone the rail is a drawer (MobileLayers). The parts that read the session — the
 * rail's, and the address held to the scope — are handed to `withSession`
 * with the placeholder that stands in for them; the layout wraps each in a
 * boundary with its own server read.
 *
 * "Skip to content" leads to the column, the one element the frame owns
 * there: the pages Next keeps hidden after the reader leaves them each hold
 * their own `main`, and an id can name only one element.
 */
export function WorkspaceFrame({ withSession, children }: Readonly<{
  /** `runAllowance`: the parts also read the team's Runs this month. */
  withSession: (parts: ReactNode, placeholder: ReactNode, runAllowance?: boolean) => ReactNode;
  children: ReactNode;
}>) {
  return (
    <MobileLayers>
      <a className="skip-link" href="#content">Skip to content</a>
      {withSession(<RunLimitBar />, null, true)}
      <div className="app-shell">
        <aside className="rail" id="primary-navigation" aria-label="Primary navigation">
          {withSession(
            <><ProjectSlot /><RouteNavigation /><div className="rail-spacer" /><UserSlot /></>,
            <><SwitcherPlaceholder /><NavigationPlaceholder /><div className="rail-spacer" /><UserPlaceholder /></>,
          )}
        </aside>
        <div className="workspace" id="content">{children}</div>
      </div>
      {withSession(<WorkspaceAddress />, null)}
    </MobileLayers>
  );
}
