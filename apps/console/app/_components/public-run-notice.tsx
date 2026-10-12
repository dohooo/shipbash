"use client";

import type { ReactNode } from "react";

import { BrandEye } from "./brand-eye";
import { PublicRunFrame } from "./public-run-frame";

/**
 * A shared link that has no run behind it — revoked, mistyped, or a fetch that
 * failed on the way. It wears the page's frame, so the reader still lands on
 * ShipBash rather than on a sentence in the corner of a white page, and the
 * well holds the same picture an empty browser frame holds: brand paper, the
 * mark at rest, a title and a line.
 *
 * At rest, deliberately. The skeleton shimmers because its layout is about to
 * arrive; nothing is on its way here, and a bar that promised otherwise would
 * be a lie the reader waits on.
 */
function PublicRunNotice({ title, copy, action }: {
  title: string;
  copy: string;
  action?: ReactNode;
}) {
  return (
    <PublicRunFrame>
      <div className="pub-notice brand-paper">
        <span className="idle-char" aria-hidden="true"><BrandEye /></span>
        <div className="idle-copy">
          <h1>{title}</h1>
          <p>{copy}</p>
          {action ? <div className="actions-row">{action}</div> : null}
        </div>
      </div>
    </PublicRunFrame>
  );
}

/** A shared link with no run behind it: revoked, mistyped, or its run is gone. */
export function PublicRunUnavailable() {
  return <PublicRunNotice
    title="This shared run is unavailable"
    copy="The link has been revoked, or the run it pointed at is gone. Ask whoever shared it for a fresh link."
  />;
}

/** A shared run that could not be read this time; the link itself is fine. */
export function PublicRunFailed({ retry }: { retry: () => void }) {
  return <PublicRunNotice
    title="Could not load this run"
    copy="Something went wrong on the way to the run. The link itself is fine — try again."
    action={<button className="button primary" onClick={retry} type="button">Try again</button>}
  />;
}
