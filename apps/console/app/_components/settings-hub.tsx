/**
 * Settings is one destination whose second column names the two scopes it
 * edits: what the team shares, and the one product the workspace is scoped to.
 * The hierarchy is drawn rather than inferred, so moving between the product
 * and the team is one click and never a different page.
 *
 * The hub is the settings layout's, drawn once for every pane: its column and
 * bar, the title and the column of panes stay on screen while the reader
 * moves between panes, and only the pane beside them is drawn anew
 * (`settings-pane-bodies.tsx`). Like the frame, it awaits nothing: the parts
 * that read the session are handed to `withSession` with what stands in for
 * them.
 */
import type { ReactNode } from "react";

import { Column } from "./column";
import { PendingSettingsHub, SettingsHubBody } from "./settings-hub-parts";
import { ColumnHead, PendingHead } from "./workspace-shell";

export function SettingsHub({ product, withSession, children }: Readonly<{
  /** Whether the address names a product, whose panes the column holds a place for until the session is read. */
  product: boolean;
  withSession: (parts: ReactNode, placeholder: ReactNode) => ReactNode;
  children: ReactNode;
}>) {
  return (
    <Column head={withSession(<ColumnHead />, <PendingHead />)}>
      {withSession(<SettingsHubBody product={product}>{children}</SettingsHubBody>, <PendingSettingsHub product={product} />)}
    </Column>
  );
}
