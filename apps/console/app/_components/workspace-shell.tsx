"use client";

/**
 * The client parts every signed-in page is drawn in. WorkspaceFrame draws the
 * rail beside it and keeps the address held to the scope (WorkspaceAddress);
 * the parts that read the session wait in the frame's session boundaries,
 * behind placeholders of their own size. Each page draws its column inside
 * its own boundary: its top bar (`topbar.tsx`), what the workspace says about
 * itself, and the page. The page gets its workspace from `WorkspaceBody`,
 * inside that boundary.
 */
import {
  LayoutDashboard,
  ListChecks,
  LogOut,
  Settings2,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { clearScopeResetFlag } from "../../lib/session-recovery";
import { Column } from "./column";
import { Dropdown } from "./dropdown";
import { useMobileLayers } from "./mobile-layers";
import { ProfileAvatar, profileHandle } from "./profile-identity";
import { DEFAULT_SETTINGS_PANE } from "./settings-panes";
import { Topbar, TopbarPlaceholder } from "./topbar";
import { useInBrowser } from "./use-in-browser";
import {
  correctedAddress,
  routePresentation,
  sectionPath,
  type ActivePage,
} from "./workspace-address";
import {
  hasProduct,
  ProductProvider,
  useResolvedWorkspace,
  useRouteScope,
  useWorkspace,
  type Workspace,
} from "./workspace-session";

/**
 * A product's page, drawn only with the product the address names. On the
 * server, `ProductPage` reads a product's data only when the session grants
 * it; here the page itself is drawn only then, and reads its product with
 * `useProduct()`. A team with no product gets the way to a first product in
 * the page's place, in a column of its own under the address's trail.
 */
export function ProductGate({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  // The workspace itself, once it is known to hold its product: the gate makes
  // no value of its own, so its readers draw only when the workspace changes.
  if (!hasProduct(workspace)) return <PageColumn><NoProject admin={workspace.team.role === "admin"} /></PageColumn>;
  return <ProductProvider value={workspace}>{children}</ProductProvider>;
}

function NoProject({ admin }: { admin: boolean }) {
  const { teamHref } = useWorkspace();
  return (
    <div className="focus-state">
      <p className="eyebrow">No Production product</p>
      <h1>{admin ? "Verify your first product" : "No projects yet"}</h1>
      <p>{admin
        ? "Enter its live URL to discover the user journeys every release should preserve."
        : "A Team Admin needs to add a Production product before verification can begin."}</p>
      {admin ? <Link className="button primary" href={teamHref("/projects/new")}>Add Production product</Link> : null}
    </div>
  );
}

// Every destination here has an address whether or not the team has a product;
// the page behind it is what offers to add one. Settings links straight to its
// first pane rather than to the address that redirects there.
const DESTINATIONS: readonly { page: ActivePage; pathname: string; label: string; Icon: LucideIcon }[] = [
  { page: "overview", pathname: "/", label: "Overview", Icon: LayoutDashboard },
  { page: "journeys", pathname: "/journeys", label: "Journeys", Icon: ListChecks },
  { page: "team", pathname: "/team", label: "Team", Icon: Users },
  { page: "settings", pathname: `/settings/${DEFAULT_SETTINGS_PANE}`, label: "Settings", Icon: SlidersHorizontal },
];

function NavItem({ active, href, label, Icon }: {
  active: boolean;
  href: Route;
  label: string;
  Icon: LucideIcon;
}) {
  const layers = useMobileLayers();
  // The default prefetch: the destination's App Shell, shared by every link to
  // it, which carries the page's skeleton and has the router fetch the page's
  // JavaScript before the click. More would render the page's per-request
  // reads once per link, for a UI no different from the skeleton.
  // On a phone a tap also closes the drawer at once, the current page's own
  // link included.
  return (
    <Link href={href} aria-current={active ? "page" : undefined} data-tip={label} onClick={() => layers?.close()}>
      <Icon className="nav-icon" aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
}

export function RouteNavigation() {
  const scope = useRouteScope();
  const pathname = usePathname();
  const { active } = routePresentation(
    sectionPath(pathname, scope.requestedTeam, scope.requestedProject ?? undefined),
  );
  return (
    <nav className="nav">
      {DESTINATIONS.map(({ page, pathname: destination, label, Icon }) => (
        <NavItem key={page} active={active === page} href={scope.href(destination)} label={label} Icon={Icon} />
      ))}
    </nav>
  );
}

/** The rail's destinations before the address is known: the same items, not yet links. */
export function NavigationPlaceholder() {
  return (
    <nav className="nav" aria-hidden="true">
      {DESTINATIONS.map(({ page, label, Icon }) => (
        <span className="nav-placeholder" key={page}>
          <Icon className="nav-icon" aria-hidden="true" />
          <span>{label}</span>
        </span>
      ))}
    </nav>
  );
}

/**
 * The account, and only the account: who is signed in, their profile and the
 * way out. Switching team is a change of scope and lives in the switcher at
 * the top of the rail, so this menu no longer offers it a second time.
 */
function UserPanel({ workspace }: { workspace: Workspace }) {
  const { profile } = workspace.session;
  return (
    <div className="user-panel">
      <Dropdown.Root className="user-control">
        <Dropdown.Trigger aria-label="Open account menu" data-tip={profile.displayName}>
          <ProfileAvatar profile={profile} />
          <span className="user-copy"><strong>{profile.displayName}</strong><span>{profileHandle(profile)}</span></span>
        </Dropdown.Trigger>
        <Dropdown.Content className="user-menu">
          <Dropdown.Close><Link href={workspace.teamHref("/profile")}><Settings2 aria-hidden="true" />Profile</Link></Dropdown.Close>
          <form action="/auth/logout" method="post"><button type="submit"><LogOut aria-hidden="true" />Sign out</button></form>
        </Dropdown.Content>
      </Dropdown.Root>
    </div>
  );
}

export function UserPlaceholder() {
  return <div className="user-panel" aria-hidden="true" />;
}

export function UserSlot() {
  const { workspace } = useResolvedWorkspace();
  if (!workspace) return <UserPlaceholder />;
  return <UserPanel workspace={workspace} />;
}

/**
 * A page's column beside the rail: its top bar, what the workspace says about
 * itself, and the page. Every page draws its own, so the bar is drawn from the
 * page's own state in the same render as the page: the address's trail by
 * default, or the page's `topbar` when it names its place in the trail or
 * acts from the bar. Whatever stands in a page's place — its skeleton, the
 * way to a first product, the route's error — draws one too.
 */
export function PageColumn({ topbar, children }: Readonly<{ topbar?: ReactNode; children: ReactNode }>) {
  return <Column head={<ColumnHead topbar={topbar} />}>{children}</Column>;
}

/** What heads a page's column: its bar, then what the workspace says about itself. */
export function ColumnHead({ topbar = <Topbar /> }: Readonly<{ topbar?: ReactNode }>) {
  return (
    <>
      {topbar}
      <RepositoryWarning />
    </>
  );
}

/**
 * The column while its page is not ready: the page's skeleton under `head`.
 * The page's boundary passes the head the server fills in once the session is
 * read (PageFallback); until then, and wherever nothing is passed, the head is
 * PendingHead.
 */
export function PendingColumn({ head = <PendingHead />, children }: Readonly<{ head?: ReactNode; children: ReactNode }>) {
  return <Column head={head}>{children}</Column>;
}

/**
 * The head of a column whose page is not ready, before its session is read.
 * The static shell is drawn once for every address, so there the bar holds a
 * single place. The browser knows the address, and draws the address's trail
 * at once: after a link's click, and once it has adopted a page load.
 */
export function PendingHead() {
  const inBrowser = useInBrowser();
  return inBrowser ? <ColumnHead /> : <TopbarPlaceholder />;
}

/** The warning under the bar that the product's repository needs attention. */
function RepositoryWarning() {
  const { workspace } = useResolvedWorkspace();
  const repository = workspace?.project?.repository;
  if (!workspace || !repository || repository.accessStatus === "ready") return null;
  return (
    <div className="project-warning" role="status"><span>GitHub repository access needs attention.</span><a href={`/${encodeURIComponent(workspace.team.slug)}/settings/github`}>Reconnect GitHub</a></div>
  );
}

/**
 * The address held to the scope on screen. It draws nothing, and sits in the
 * frame, so it acts once for the workspace while pages change beside it.
 */
export function WorkspaceAddress() {
  const { scope, query, workspace } = useResolvedWorkspace();
  const pathname = usePathname();
  const router = useRouter();
  const loaded = query.isSuccess;
  useEffect(() => {
    // A workspace that loaded proves the scope is sound again, so the one
    // reset the circuit breaker allows becomes available for the next
    // genuinely stale address.
    if (loaded) clearScopeResetFlag();
  }, [loaded]);
  // The URL has to name the scope it is showing: when the session resolves to
  // a different team or product than the path asked for, the address is
  // corrected rather than left lying about what is on screen.
  const target = workspace ? correctedAddress({
    pathname,
    team: workspace.team,
    project: workspace.project,
    requestedTeam: scope.requestedTeam,
    requestedProject: scope.requestedProject,
  }) : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);
  return null;
}
