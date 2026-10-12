import type { ReactNode } from "react";

import { SettingsHub } from "../../../../_components/settings-hub";
import { sessionBoundary } from "../../../_lib/frame-session";

/**
 * The hub every pane of a product's Settings is drawn in, kept on screen while
 * the reader moves between panes. Adding a way in is an address of its own
 * under Settings, outside this group, so it is drawn without the hub.
 */
export default function SettingsLayout({ children, params }: Readonly<{
  children: ReactNode;
  params: Promise<{ team: string }>;
}>) {
  return <SettingsHub product withSession={sessionBoundary(params)}>{children}</SettingsHub>;
}
