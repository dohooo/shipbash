"use client";

/**
 * Which workspace an address means, and the session that decides it.
 *
 * The frame's parts and every page have to answer that question before they
 * can draw anything, each in a boundary of its own, so it lives below all of
 * them rather than inside any one.
 */
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Route } from "next";
import { useParams } from "next/navigation";
import { createContext, useContext } from "react";

import { readQuery, type Project, type Session, type Team } from "../../lib/web-client";
import { pathWithScope, resolveScope } from "./workspace-address";

export interface Workspace {
  session: Session;
  team: Team;
  project: Project | null;
  teamHref: (pathname: string, options?: { project?: string | null | undefined; tab?: string | undefined }) => Route;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("useWorkspace must be used inside WorkspaceBody.");
  return workspace;
}

/** The workspace of a product's page: the product the address names is there. */
interface ProductWorkspace extends Workspace {
  project: Project;
}

export function hasProduct(workspace: Workspace): workspace is ProductWorkspace {
  return workspace.project !== null;
}

const ProductContext = createContext<ProductWorkspace | null>(null);

export const ProductProvider = ProductContext.Provider;

/**
 * The workspace `ProductGate` hands its page: the product is there. Everything
 * on a product's page reads it here, so none of it waits on a product or
 * carries a placeholder for one.
 */
export function useProduct(): ProductWorkspace {
  const product = useContext(ProductContext);
  if (!product) throw new Error("useProduct must be used inside ProductGate.");
  return product;
}

/** The scope the URL asked for, before the session says what it grants. */
interface RouteScope {
  requestedTeam: string;
  requestedProject: string | null;
  href: Workspace["teamHref"];
}

/** The scope the address asks for, read from the address itself. */
export function useRouteScope(): RouteScope {
  const { team: requestedTeam, project } = useParams<{ team: string; project?: string }>();
  const requestedProject = project ?? null;
  return {
    requestedTeam,
    requestedProject,
    href: (pathname, options = {}) => pathWithScope(
      pathname,
      requestedTeam,
      options.project === undefined ? requestedProject : options.project,
      options.tab,
    ),
  };
}

function useSession(requestedTeam: string) {
  return useQuery(readQuery("session", requestedTeam));
}

/**
 * The workspace the address resolves to once its session is read, beside the
 * scope and the read it came from; null until then, and when it resolves to none.
 */
export function useResolvedWorkspace() {
  const scope = useRouteScope();
  const query = useSession(scope.requestedTeam);
  const workspace = query.data ? resolvedWorkspace(query.data, scope) : null;
  return { scope, query, workspace };
}

/**
 * The session the address asks for, read the way the workspace reads it. A
 * component that falls back to the session once its own draft goes reads it
 * here rather than through the workspace, whose copy can reach it a render later.
 */
export function useRouteSession(): Session {
  return useSuspenseQuery(readQuery("session", useRouteScope().requestedTeam)).data;
}

export function resolvedWorkspace(session: Session, scope: RouteScope): Workspace | null {
  const resolved = resolveScope(session, scope.requestedTeam, scope.requestedProject);
  if (!resolved) return null;
  const { team, project } = resolved;
  return {
    session,
    team,
    project,
    teamHref: (pathname, options = {}) => pathWithScope(
      pathname,
      team.slug,
      options.project === undefined ? project?.slug ?? null : options.project,
      options.tab,
    ),
  };
}
