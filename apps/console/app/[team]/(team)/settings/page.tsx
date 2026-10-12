import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { HubPaneSkeleton } from "../../../_components/settings-pane-bodies";
import { DEFAULT_SETTINGS_PANE } from "../../../_components/settings-panes";

export const metadata: Metadata = { title: "Settings" };

type SettingsParams = { params: Promise<{ team: string }> };

async function ToDefaultPane({ params }: SettingsParams) {
  const { team } = await params;
  return redirect(`/${encodeURIComponent(team)}/settings/${DEFAULT_SETTINGS_PANE}`);
}

/** Settings always names the pane it is showing, so the bare address picks one. */
export default function Page({ params }: SettingsParams) {
  return <Suspense fallback={<HubPaneSkeleton />}><ToDefaultPane params={params} /></Suspense>;
}
