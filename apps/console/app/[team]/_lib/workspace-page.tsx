import { dehydrate, HydrationBoundary, type QueryClient } from "@tanstack/react-query";
import { Suspense, type ReactNode } from "react";

import { ServerReadError } from "../../_components/route-error";
import { names } from "../../_components/workspace-address";
import { WorkspaceBody } from "../../_components/workspace-body";
import { readFailure } from "../../_lib/request-errors";
import { makeQueryClient } from "../../../lib/query-client";
import { serverFailure, serverLoad, serverReadQuery } from "../../../lib/server-client";
import type { Session } from "../../../lib/web-client";
import { sessionContract } from "../../../lib/api-contracts";
import { PageFallback } from "./page-fallback";

/** What a team's address names; a product's names one of its products too. */
interface WorkspaceRoute {
  team: string;
  project?: string;
}

interface ProductRoute extends WorkspaceRoute {
  project: string;
}

/** The ids behind the slugs in the path, once the session has said what they name. */
export interface WorkspaceScope {
  teamId: string;
  projectId: string | null;
}

export interface ProductScope {
  teamId: string;
  projectId: string;
}

/**
 * The ids the path names, matched exactly: an address the session does not
 * grant names nothing here, so the page reads nothing for it and the
 * workspace corrects the address on arrival.
 */
function scopeIds(session: Session, team: string, project: string | undefined): WorkspaceScope | null {
  const resolvedTeam = session.teams.find((candidate) => names(candidate, team));
  if (!resolvedTeam) return null;
  const resolvedProject = session.projects.find((candidate) => (
    candidate.teamId === resolvedTeam.id && names(candidate, project)
  ));
  return { teamId: resolvedTeam.id, projectId: resolvedProject?.id ?? null };
}

function productScope(scope: WorkspaceScope): ProductScope | null {
  return scope.projectId === null ? null : { teamId: scope.teamId, projectId: scope.projectId };
}

/**
 * Whether the address names a Team this reader is not in — the one case the
 * evidence gate answers.
 *
 * Read without a team filter on purpose: the scoped session read answers a
 * Team the reader cannot see with the same 404 a transient failure produces,
 * and a failure must never be mistaken for a wall. An unreadable session is
 * reported by the workspace, which is the place that can retry it.
 */
export async function outsideRequestedTeam(team: string): Promise<boolean> {
  const teams = await serverLoad(sessionContract, { query: {} })
    .then((session) => session.teams)
    .catch(() => null);
  if (!teams) return false;
  return !teams.some((candidate) => candidate.slug === team || candidate.id === team);
}

interface PageProps<Route extends WorkspaceRoute, Scope> {
  params: Promise<Route>;
  /** The page's own skeleton: what stands where the page will be until it is ready. */
  fallback: ReactNode;
  /**
   * The page is drawn in the column its layout draws, as a Settings pane is in
   * the hub's, rather than in one of its own: what stands in its place is then
   * drawn in that column too.
   */
  inLayoutColumn?: true;
  /**
   * The page's first-screen reads into `client`, under the keys the page reads
   * them by — `serverReadQuery(..)` for a read, or the read's own options
   * function where its key goes past its arguments. Made only when the session
   * grants the scope the address names; the session is the one the scope was
   * resolved from. A read that fails is the page's error, drawn by the route,
   * unless it was prefetched with `prefetchTolerated` because the page is
   * still worth drawing without it.
   */
  prefetch?: ((client: QueryClient, scope: Scope, route: Route, session: Session) => Promise<unknown>) | undefined;
  /** The page, or how to draw it from its address (and, for a gate, the scope it resolved to). */
  children: ReactNode | ((route: Route, scope: Scope | null) => ReactNode | Promise<ReactNode>);
}

async function WorkspaceContent<Route extends WorkspaceRoute, Scope>({ params, pending, inLayoutColumn, scopeOf, prefetch, children }: Readonly<
  PageProps<Route, Scope> & { pending: ReactNode; scopeOf: (scope: WorkspaceScope) => Scope | null }
>) {
  const route = await params;
  const client = makeQueryClient();
  // The reader's session for this request; the rail's parts read the same one,
  // and the transport answers it once per render.
  const session = serverReadQuery("session", route.team);
  await client.prefetchQuery(session);
  const granted = client.getQueryData(session.queryKey);
  const resolved = granted ? scopeIds(granted, route.team, route.project) : null;
  const scope = resolved ? scopeOf(resolved) : null;
  if (granted && scope && prefetch) await prefetch(client, scope, route, granted);
  // Run even when a read failed: a page's gate may send the reader on.
  const page = typeof children === "function" ? await children(route, scope) : children;
  // A read the server could not make goes to the browser as it is, to be
  // drawn as the route's error.
  const failed = serverFailure(client);
  if (failed) {
    return <ServerReadError failure={readFailure(failed.state.error)} fallback={pending} />;
  }
  return (
    <HydrationBoundary state={dehydrate(client)}>
      <WorkspaceBody inLayoutColumn={inLayoutColumn}>{page}</WorkspaceBody>
    </HydrationBoundary>
  );
}

/** The page's boundary: its skeleton, in a column of its own unless its layout draws one. */
function pageBoundary<Route extends WorkspaceRoute, Scope>(
  props: Readonly<PageProps<Route, Scope>>,
  scopeOf: (scope: WorkspaceScope) => Scope | null,
) {
  const pending = props.inLayoutColumn ? props.fallback : <PageFallback params={props.params}>{props.fallback}</PageFallback>;
  return <Suspense fallback={pending}><WorkspaceContent {...props} pending={pending} scopeOf={scopeOf} /></Suspense>;
}

/**
 * A workspace page: its own skeleton, then everything its first screen reads,
 * read on the server for this request and handed to the browser already
 * answered, then the page in the workspace the address names. The boundary
 * holds the page's whole column, top bar included, so the bar is drawn on the
 * server with the page: over the skeleton the address's trail, streamed as
 * soon as the session is read (PageFallback), and over the page the page's
 * own bar.
 *
 * The boundary is the page's own and is rendered before anything is awaited,
 * so it is in the static shell a page load paints first and in the App Shell a
 * link prefetches. The skeleton is drawn with client components, and a client
 * component brings its route's client chunks, so the router also has the
 * page's JavaScript before the click. The page replaces its skeleton once,
 * with everything it needs. A page under a product uses ProductPage, whose
 * reads get the product's id.
 */
export function WorkspacePage<Route extends WorkspaceRoute>(props: Readonly<PageProps<Route, WorkspaceScope>>) {
  return pageBoundary(props, (scope) => scope);
}

/** A page under a product: as WorkspacePage, read only when the session grants the product the address names. */
export function ProductPage<Route extends ProductRoute>(props: Readonly<PageProps<Route, ProductScope>>) {
  return pageBoundary(props, productScope);
}
