"use client";

/**
 * The top bar over every workspace page: the trail on the left, and what the
 * page does from there on the right. It heads the page's column (PageColumn),
 * inside the page's own boundary, so it is drawn on the server with the page
 * and from the same state the page draws from.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { DrawerOpenButton, useMobileLayers } from "./mobile-layers";
import { ProfileAvatar } from "./profile-identity";
import { routePresentation, sectionPath, type Breadcrumb } from "./workspace-address";
import { useResolvedWorkspace } from "./workspace-session";

/**
 * The trail over the page: the one the page names, or the address's own, with
 * a bar where only the page knows the name. `settled` gives each such place
 * its word, over a page that will not name it.
 */
function Crumbs({ trail, settled }: Readonly<{ trail: readonly Breadcrumb[] | undefined; settled: boolean }>) {
  const { scope, workspace } = useResolvedWorkspace();
  const pathname = usePathname();
  const address = routePresentation(sectionPath(pathname, scope.requestedTeam, scope.requestedProject ?? undefined)).breadcrumbs;
  const breadcrumbs = trail ?? (settled ? address.map((crumb) => ({ ...crumb, placeholder: false })) : address);
  // The icon rail no longer spells the project name, so the subject the
  // address names leads the breadcrumb instead; the crumb only renders
  // alongside that rail (CSS). A team-scoped address names no product, and
  // leading with one put a product's name over a link to the team root.
  const lead = scope.requestedProject === null ? workspace?.team : workspace?.project;
  return (
    <nav className="crumbs" aria-label="Breadcrumb"><ol>{lead ? (
      <li className="crumb-item crumb-project"><Link href={scope.href("/")}>{lead.name}</Link><span aria-hidden="true">/</span></li>
    ) : null}{breadcrumbs.map((breadcrumb, index) => {
      const current = index === breadcrumbs.length - 1;
      const label = breadcrumb.placeholder
        ? <><span className="skel-bar" data-bar="crumb" aria-hidden="true" /><span className="sr-only">{breadcrumb.label}</span></>
        : breadcrumb.label;
      return <li className="crumb-item" key={breadcrumb.pathname ?? breadcrumb.label}>{index > 0 ? <span aria-hidden="true">/</span> : null}{breadcrumb.pathname && !current
        ? <Link href={scope.href(breadcrumb.pathname, { tab: breadcrumb.tab })}>{label}</Link>
        : <span aria-current={current ? "page" : undefined}>{label}</span>}{breadcrumb.when
        // A sibling, never inside the crumb: `[aria-current]` is clamped with
        // an ellipsis, so a clock nested in there is the first text cut.
        ? <span className="crumb-when">({breadcrumb.when})</span> : null}</li>;
    })}</ol></nav>
  );
}

/** On a phone, the signed-in person at the bar's end: it opens the drawer their account menu sits in. */
function AccountButton() {
  const layers = useMobileLayers();
  const { workspace } = useResolvedWorkspace();
  if (!layers || !workspace) return null;
  return (
    <button className="m-avatar" type="button" aria-label="Open account and navigation" onClick={() => layers.show("drawer")}>
      <ProfileAvatar profile={workspace.session.profile} />
    </button>
  );
}

/**
 * The bar: the trail, and the page's actions beside it when it has any. A page
 * that names its place in the trail passes `trail`; while it is still reading
 * the name it passes none, and the address's trail holds the place. On a phone
 * it also carries the way into the drawer and the account (`mobile.css`).
 */
export function Topbar({ trail, settled = false, actions }: Readonly<{
  trail?: readonly Breadcrumb[] | undefined;
  settled?: boolean | undefined;
  actions?: ReactNode;
}>) {
  return (
    <header className="topbar">
      <DrawerOpenButton />
      <Crumbs trail={trail} settled={settled} />
      {actions ? <div className="topbar-aside">{actions}</div> : null}
      <AccountButton />
    </header>
  );
}

/** The bar before the address is known: one bar where the current page's name will be. */
export function TopbarPlaceholder() {
  return (
    <header className="topbar">
      <DrawerOpenButton />
      <nav className="crumbs" aria-hidden="true">
        <ol><li className="crumb-item"><span className="skel-bar" data-bar="crumb" /></li></ol>
      </nav>
    </header>
  );
}
