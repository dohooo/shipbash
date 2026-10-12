import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HubPane, HubPaneSkeleton } from "../../../../../_components/settings-pane-bodies";
import { isSettingsPane, SETTINGS_PANES } from "../../../../../_components/settings-panes";
import { prefetchSettingsPane } from "../../../../_lib/settings-prefetch";
import { ProductPage } from "../../../../_lib/workspace-page";

type PaneParams = { params: Promise<{ team: string; project: string; pane: string }> };

export async function generateMetadata({ params }: PaneParams): Promise<Metadata> {
  const { pane } = await params;
  return isSettingsPane(pane) ? { title: SETTINGS_PANES[pane].label } : {};
}

/** The same pane, at the address of the product the switcher has selected. */
export default function Page({ params }: PaneParams) {
  return (
    <ProductPage params={params} inLayoutColumn fallback={<HubPaneSkeleton />} prefetch={prefetchSettingsPane}>
      {({ pane }) => (isSettingsPane(pane) ? <HubPane pane={pane} /> : notFound())}
    </ProductPage>
  );
}
