import type { ReactNode } from "react";

import { SettingsHub } from "../../../_components/settings-hub";
import { sessionBoundary } from "../../_lib/frame-session";

/**
 * The hub every pane of Settings at the team's own address is drawn in, kept
 * on screen while the reader moves between panes.
 */
export default function SettingsLayout({ children, params }: Readonly<{
  children: ReactNode;
  params: Promise<{ team: string }>;
}>) {
  return <SettingsHub product={false} withSession={sessionBoundary(params)}>{children}</SettingsHub>;
}
