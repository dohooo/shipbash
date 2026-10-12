"use client";

import Link from "next/link";

import { Empty } from "../_components/shell";
import { Topbar } from "../_components/topbar";
import { PageColumn } from "../_components/workspace-shell";
import { useRouteScope } from "../_components/workspace-session";

/**
 * What a workspace page's notFound() draws — today, a settings pane that does
 * not exist. It is drawn inside the frame, as the workspace's error is, so the
 * rail stays usable instead of the whole page giving way to a bare 404, under
 * the address's trail with each held place given its word. An address that
 * matches no route at all still gets the root's 404.
 */
export default function WorkspaceNotFound() {
  const scope = useRouteScope();
  return (
    <PageColumn topbar={<Topbar settled />}>
      <div className="page">
        <Empty
          title="Nothing is at this address"
          body="It may have moved, or it never existed."
          action={<Link className="button" href={scope.href("/")}>Go to the Overview</Link>}
        />
      </div>
    </PageColumn>
  );
}
