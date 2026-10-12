"use client";

import type { ReactNode } from "react";

import { PublicBrandEye } from "./public-brand-eye";

/**
 * The frame every state of a shared link wears: the run itself, the skeleton
 * before it arrives, and the notice when it never will. A bar on top, the well
 * the state fills, and the invitation closing the page. The bar is the
 * caller's, because the run page's own bar names the run — a state that knows
 * no name brings its drawn twin (PublicRunTopbarSkeleton) or an empty rule
 * instead, and the well is the only thing that really differs. A second copy
 * of this page's outline elsewhere is how a loading page and a loaded one stop
 * lining up. It is a page column (`column.tsx`), so the run's layout rules
 * find the run in its `main`, with the invitation under it.
 */
export function PublicRunFrame({ topbar, children }: {
  /** The page's own bar. Without one the rule is drawn and left empty. */
  topbar?: ReactNode;
  children: ReactNode;
}) {
  return <div className="page-column">
    {topbar ?? <header className="topbar" />}
    <main id="content">{children}</main>
    <PublicInvitation />
  </div>;
}

/**
 * The invitation, at the foot of the page rather than the top right: a reader
 * outside the team has to see the run before being asked anything, so the ask
 * sits after the evidence. It is a flex sibling of #content, never an overlay —
 * the page is 100dvh and clipped, so anything fixed would cover the last line
 * of the execution log instead of making the run grid give up the height.
 *
 * It owes nothing to the fetch, so every state wears it: the one row of the
 * page that is already true before the run lands, and still true if it never
 * does.
 */
function PublicInvitation() {
  return <footer className="pub-cta">
    <span className="pub-brand"><span className="pub-eye" aria-hidden="true"><PublicBrandEye /></span><b>ShipBash</b></span>
    <p>Your 24/7 testing team — you ship, we bash.</p>
    <span className="pub-cta-act">
      <a className="button primary" href="/login">Log in</a>
      <a className="button pub-ghost" href="/login">Start free</a>
    </span>
  </footer>;
}
