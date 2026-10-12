import type { Route } from "next";

import type { Project, Session, Team } from "../../lib/web-client";
import { route } from "../_lib/route";
import { DEFAULT_SETTINGS_PANE, SETTINGS_PANES, SETTINGS_SECTIONS, isSettingsPane } from "./settings-panes";

/*
 * Addresses: what a workspace URL names and how links are built. Plain
 * functions, so the server (a page resolving the ids behind a path) and the
 * browser read an address the same way.
 */

/**
 * Whether a path segment names this team or product. A segment is matched by
 * slug or by id, so a link written before slugs existed still resolves — and
 * the workspace then rewrites the address to the slug form on arrival.
 */
export function names(subject: { id: string; slug: string }, segment: string | null | undefined): boolean {
  return segment !== null && segment !== undefined && (subject.slug === segment || subject.id === segment);
}

/** The address of a scope, which is what every workspace link is built on. */
export function scopePath(teamSlug: string, projectSlug: string | null): Route {
  return route(projectSlug
    ? `/${encodeURIComponent(teamSlug)}/${encodeURIComponent(projectSlug)}`
    : `/${encodeURIComponent(teamSlug)}`);
}

/**
 * Addresses that name no product, because their subject is not one: adding a
 * product, and the reader's own profile.
 */
const TEAM_ONLY_SECTIONS = new Set(["/profile", "/projects/new"]);

/**
 * Sections that also live under the team alone. Each already knows what to say
 * without a product — the product-shaped ones offer to add one, Settings draws
 * the team's panes and leaves the product group off its column — so the address
 * exists and the page explains itself. What is left out is everything that
 * names one product's work, which has nothing to show and nothing to offer
 * while the team has no product.
 */
const PRODUCT_OPTIONAL_SECTIONS = new Set([
  "/",
  "/journeys",
  "/team",
  ...SETTINGS_SECTIONS,
]);

function reachableWithoutProduct(section: string): boolean {
  return TEAM_ONLY_SECTIONS.has(section) || PRODUCT_OPTIONAL_SECTIONS.has(section);
}

/**
 * Sections that name a place rather than a thing. Anything deeper — a journey,
 * a run, a draft, one product's settings — names an id that belongs to a single
 * product and means nothing under another.
 */
const PORTABLE_SECTIONS = new Set([
  "/proposals",
  "/settings/sign-ins/new",
  "/sign-ins/setup",
  ...TEAM_ONLY_SECTIONS,
  ...PRODUCT_OPTIONAL_SECTIONS,
]);

/**
 * Whether an address still names the product the URL asked for. Matching by
 * slug or id means normalizing `/id/id` to `/slug/slug` counts as the same
 * product, while a product that was deleted or switched away from does not.
 */
function namesSameProduct(
  project: { id: string; slug: string } | null,
  requested: string | null,
): boolean {
  return project ? names(project, requested) : requested === null;
}

/**
 * Whether the section below the scope survives a corrected address.
 *
 * It always survives when the address still names the same product: rewriting
 * `/id/id` to `/slug/slug` changes the address, not the subject. Otherwise it
 * has to name a place rather than a thing, and the new address has to have a
 * product for it to sit under — which is what deleting a product removes.
 */
function carriesSection(
  section: string,
  project: { id: string; slug: string } | null,
  requestedProject: string | null,
): boolean {
  if (namesSameProduct(project, requestedProject)) return true;
  const target = section || "/";
  if (!PORTABLE_SECTIONS.has(target)) return false;
  return project !== null || reachableWithoutProduct(target);
}

/**
 * The scope is part of the address, not a decoration on it: a link carries the
 * team and project it means, so it resolves the same for whoever opens it. Only
 * `tab`, which is a view preference rather than a subject, stays in the query.
 */
export function pathWithScope(
  pathname: string,
  teamSlug: string,
  projectSlug: string | null,
  tab?: string,
): Route {
  const product = TEAM_ONLY_SECTIONS.has(pathname) ? null : projectSlug;
  const scope = scopePath(teamSlug, product);
  // Only a section that describes a product is stranded without one; the rest
  // keep their address, which is how a team with no product still navigates.
  const stranded = !product && !reachableWithoutProduct(pathname);
  const path = pathname === "/" || stranded ? scope : `${scope}${pathname}`;
  return route(tab ? `${path}?tab=${encodeURIComponent(tab)}` : path);
}

/** The route below the scope, so route matching never has to know the ids. */
export function sectionPath(pathname: string, teamId?: string, projectId?: string): string {
  let rest = pathname;
  for (const segment of [teamId, projectId]) {
    if (!segment) break;
    const prefix = `/${segment}`;
    if (rest === prefix) return "/";
    if (!rest.startsWith(`${prefix}/`)) break;
    rest = rest.slice(prefix.length);
  }
  return rest || "/";
}

interface AddressedScope {
  team: { slug: string };
  /** The product the session resolved, when the team has one. */
  project: { id: string; slug: string } | null;
  requestedTeam: string;
  /** The product the URL asked for. */
  requestedProject: string | null;
  pathname: string;
}

/**
 * The URL has to name the scope it is showing. When the session resolves to a
 * different team or product than the path asked for — a bare team that has a
 * product, an id the session can no longer see — this is the address it should
 * be corrected to; `null` when it already names what is on screen.
 */
export function correctedAddress({ team, project, requestedTeam, requestedProject, pathname }: AddressedScope): Route | null {
  const productSlug = project?.slug ?? null;
  const addressed = scopePath(team.slug, productSlug);
  const shown = scopePath(requestedTeam, requestedProject ?? productSlug);
  if (addressed === shown) return null;
  const section = pathname.startsWith(shown) ? pathname.slice(shown.length) : "";
  const carried = carriesSection(section, project, requestedProject) ? section : "";
  // Built the same way every other link is, so a corrected address can never
  // be one the app would not have produced itself.
  return pathWithScope(carried || "/", team.slug, productSlug);
}

/** A team's products: what its Settings panes list, on the server and in the browser alike. */
export function teamProjects(session: Session, teamId: string): Project[] {
  return session.projects.filter((candidate) => candidate.teamId === teamId);
}

/**
 * What the session actually grants for the ids in the path: the team it asked
 * for when the session still has it, otherwise the account's active team, and
 * that team's first product when the path names none.
 */
export function resolveScope(
  session: Session,
  requestedTeam: string | null,
  requestedProject: string | null,
): { team: Team; project: Project | null } | null {
  const team = session.teams.find((candidate) => names(candidate, requestedTeam))
    ?? session.teams.find((candidate) => candidate.id === session.activeTeamId)
    ?? session.teams[0];
  if (!team) return null;
  const products = teamProjects(session, team.id);
  return {
    team,
    project: products.find((candidate) => names(candidate, requestedProject)) ?? products[0] ?? null,
  };
}

/**
 * Four first-class destinations; everything else lives underneath one of them.
 * A page reached from the avatar rather than the rail belongs to none of them,
 * which is what `null` says — nothing in the rail is highlighted for it.
 */
export type ActivePage = "overview" | "journeys" | "team" | "settings";

export interface Breadcrumb {
  label: string;
  pathname?: string;
  tab?: string;
  /** The run's own clock, drawn beside the last crumb — never inside it. */
  when?: string;
  /**
   * A name only the page knows, once it has read what it shows. Until the
   * page names it, the trail holds its place with a bar, so the name replaces
   * the bar rather than a generic word.
   */
  placeholder?: boolean;
}

/**
 * The settings destinations that name a place of their own, each one crumbed
 * under Settings. Everything above them is decided before this is reached.
 */
function settingsPresentation(
  pathname: string,
): { active: ActivePage; breadcrumbs: Breadcrumb[] } | null {
  // The crumb goes straight to the first pane, not to the address that redirects there.
  const settings = { label: "Settings", pathname: `/settings/${DEFAULT_SETTINGS_PANE}` };
  // Saving a way in needs a browser, which a settings pane has no room for —
  // so it is an address of its own, crumbed under the settings it came from.
  if (pathname === "/settings/sign-ins/new") {
    return { active: "settings", breadcrumbs: [settings, { label: "Add a way in" }] };
  }
  if (pathname === "/settings") return { active: "settings", breadcrumbs: [{ label: "Settings" }] };
  // A pane IS its address, so its crumb is read off the address here rather
  // than announced by the hub once it has mounted — which is what made the
  // trail show "Settings / Settings" and then replace it a frame later.
  const pane = pathname.slice("/settings/".length);
  if (isSettingsPane(pane)) {
    return { active: "settings", breadcrumbs: [settings, { label: SETTINGS_PANES[pane].label }] };
  }
  // A pane that does not exist is still Settings: its page says so inside the frame.
  if (pathname.startsWith("/settings/")) return { active: "settings", breadcrumbs: [settings] };
  return null;
}

/**
 * A run, a live walk and what a run left to answer. Runs left the navigation:
 * a run is a walk of journeys, reached from a journey's History or from the
 * Overview alert, so it reads as a leaf of Journeys, never as a section of
 * its own.
 */
function walkPresentation(pathname: string): { active: ActivePage; breadcrumbs: Breadcrumb[] } | null {
  const journeys = { label: "Journeys", pathname: "/journeys" };
  const takeover = /^\/verifications\/([^/]+)\/takeover$/.exec(pathname);
  if (takeover) {
    return { active: "journeys", breadcrumbs: [
      journeys,
      { label: "Run", pathname: `/verifications/${takeover[1]}`, placeholder: true },
      { label: "Take control" },
    ] };
  }
  if (pathname.startsWith("/verifications/")) return { active: "journeys", breadcrumbs: [journeys, { label: "Run", placeholder: true }] };
  // Most walks are explorations, so the word stands until the page says otherwise.
  if (pathname.startsWith("/activities/")) return { active: "journeys", breadcrumbs: [journeys, { label: "Exploring" }] };
  return null;
}

export function routePresentation(
  pathname: string,
): { active: ActivePage | null; breadcrumbs: Breadcrumb[] } {
  if (pathname === "/") return { active: "overview", breadcrumbs: [{ label: "Overview" }] };
  if (pathname === "/projects/new") return { active: "settings", breadcrumbs: [{ label: "Add project" }] };
  if (pathname === "/journeys") return { active: "journeys", breadcrumbs: [{ label: "Journeys" }] };
  if (pathname === "/journeys/new") {
    return { active: "journeys", breadcrumbs: [{ label: "Journeys", pathname: "/journeys" }, { label: "New journey" }] };
  }
  if (pathname.startsWith("/journeys/")) {
    return { active: "journeys", breadcrumbs: [{ label: "Journeys", pathname: "/journeys" }, { label: "Journey", placeholder: true }] };
  }
  if (pathname === "/proposals" || pathname.startsWith("/proposals/")) {
    return { active: "journeys", breadcrumbs: [{ label: "Journeys", pathname: "/journeys" }, { label: "Draft journeys" }] };
  }
  const walk = walkPresentation(pathname);
  if (walk) return walk;
  // Saving a way in is the step after the product exists, so it reads as part
  // of getting started rather than as a setting filed away from it.
  if (pathname === "/sign-ins/setup") return { active: "overview", breadcrumbs: [{ label: "Sign-ins" }] };
  // Who is on the team is not a setting of one product, so it answers for
  // itself in the rail rather than as a page filed under Settings.
  if (pathname === "/team") return { active: "team", breadcrumbs: [{ label: "Team" }] };
  // The reader's own profile is neither the team's nor a product's, so no rail
  // destination owns it and the trail leads with the page itself.
  if (pathname === "/profile") return { active: null, breadcrumbs: [{ label: "Profile" }] };
  return settingsPresentation(pathname) ?? { active: "overview", breadcrumbs: [{ label: "Overview" }] };
}
