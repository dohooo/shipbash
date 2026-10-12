"use client";

import type { StoredActivityLayouts } from "../_lib/activity-layout";
import { activityPageModel } from "./activity-page-model";
import { useActivityPageState } from "./activity-page-state";
import { ActivityPageBody } from "./activity-page-view";
import { ActivityTopbarAside } from "./activity-topbar-aside";
import { PageColumn, ProductGate, QueryError, Topbar } from "./shell";

/**
 * The Activity page before its run has answered: the page's body, empty. Which
 * layout the page opens on depends on the Activity's kind and on the reader's
 * choice for it, and neither is known before the run is read — the route's
 * boundary draws this in the static shell, one for every Activity — so nothing
 * drawn here may stand where only one of the layouts would. The page then
 * appears once, already in its layout. It is the route's boundary fallback and
 * the page's own pending state.
 */
export function PendingActivityPage() {
  return <div className="page activity-page" aria-busy="true" />;
}

/**
 * The Activity page past its product's gate: an Activity that has been read,
 * under a bar that names what kind of run it is and, once read, carries its
 * hand-off and its layout switch. Past it the page is a pure
 * function of the run — its state hook, its model, and its view. A failed
 * poll of an Activity already on screen leaves it there; the next poll
 * retries.
 */
function ActivityContent({ activityId, storedLayouts }: { activityId: string; storedLayouts: StoredActivityLayouts }) {
  const page = useActivityPageState(activityId, storedLayouts);
  const { query } = page;
  const topbar = <Topbar trail={page.trail} />;
  if (query.isPending) return <PageColumn topbar={topbar}><PendingActivityPage /></PageColumn>;
  if (query.isLoadingError) {
    return <PageColumn topbar={topbar}><QueryError error={query.error} retry={() => void query.refetch()} /></PageColumn>;
  }
  const ready = { ...page, activity: query.data };
  const model = activityPageModel(ready);
  return (
    <PageColumn topbar={<Topbar trail={page.trail} actions={<ActivityTopbarAside page={ready} model={model} />} />}>
      <ActivityPageBody page={ready} model={model} />
    </PageColumn>
  );
}

/** `storedLayouts`: the reader's layout per Activity kind, as this request's cookies held it. */
export function ActivityPage({ activityId, storedLayouts }: { activityId: string; storedLayouts: StoredActivityLayouts }) {
  return <ProductGate><ActivityContent activityId={activityId} storedLayouts={storedLayouts} /></ProductGate>;
}
