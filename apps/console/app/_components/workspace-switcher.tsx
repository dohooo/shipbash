"use client";

/**
 * The rail's scope switcher: which team, and which of its products, everything
 * below is read in. It carries the team list because switching team is a change
 * of scope, which is what this control is for — the account menu at the foot of
 * the rail answers for the person, not for the work.
 */
import type { Route } from "next";
import Link from "next/link";

import { Dropdown } from "./dropdown";
import { DrawerCloseButton } from "./mobile-layers";
import { pathWithScope, resolveScope, teamProjects } from "./workspace-address";
import { projectMark, teamMark } from "./workspace-marks";
import { useResolvedWorkspace, type Workspace } from "./workspace-session";

/** One thing the switcher can switch to, whichever of the two scopes it names. */
function ScopeOption({ href, name, current }: { href: Route; name: string; current: boolean }) {
  return (
    <Dropdown.Close>
      <Link className="project-menu-option" href={href} aria-current={current ? "true" : undefined}>
        <span>{name}</span>
        {current ? <span className="project-menu-check" aria-hidden="true">✓</span> : null}
      </Link>
    </Dropdown.Close>
  );
}

function ProjectSelector({ workspace, teamScoped }: { workspace: Workspace; teamScoped: boolean }) {
  const { project, session, team, teamHref } = workspace;
  const projects = teamProjects(session, team.id);
  // An address that names no product is the team's, so the switcher names the
  // team. Falling back to "No project" made the destination look broken the
  // moment it stopped being a product's.
  const subject = teamScoped ? team.name : project?.name ?? "No project";
  const mark = teamScoped ? teamMark(team.name) : projectMark(project);
  return (
    <div className="project-switcher">
      <Dropdown.Root className="project-menu">
        <Dropdown.Trigger aria-label="Select project" data-tip={subject}>
          <span className="rail-mark" aria-hidden="true">{mark}</span>
          <span className="project-menu-current">{subject}</span>
        </Dropdown.Trigger>
        <Dropdown.Content className="project-menu-list">
          {/* Drawn even for one team, so the place a company team appears in is already known. */}
          <div className="project-menu-actions">
            <span className="project-menu-label">Teams</span>
            {session.teams.map((candidate) => (
              <ScopeOption
                key={candidate.id}
                // Straight to the team's first product: the address the
                // workspace would otherwise correct this link to on arrival.
                href={pathWithScope("/", candidate.slug, resolveScope(session, candidate.id, null)?.project?.slug ?? null)}
                name={candidate.name}
                current={candidate.id === team.id}
              />
            ))}
          </div>
          <Dropdown.Separator />
          <div className="project-menu-actions">
            <span className="project-menu-label">Projects in {team.name}</span>
            {projects.map((candidate) => (
              <ScopeOption
                key={candidate.id}
                href={teamHref("/", { project: candidate.slug })}
                name={candidate.name}
                current={!teamScoped && candidate.id === project?.id}
              />
            ))}
            {!projects.length ? <span className="project-menu-empty">No projects yet</span> : null}
          </div>
          {team.role === "admin" ? (
            <><Dropdown.Separator /><div className="project-menu-actions"><Dropdown.Close><Link className="project-menu-option" href={teamHref("/projects/new")}>Add project</Link></Dropdown.Close></div></>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Root>
      <DrawerCloseButton />
    </div>
  );
}

/** The switcher's place in the rail before the session has said what it can switch between. */
export function SwitcherPlaceholder() {
  return <div className="project-switcher" aria-hidden="true" />;
}

export function ProjectSlot() {
  const { scope, workspace } = useResolvedWorkspace();
  if (!workspace) return <SwitcherPlaceholder />;
  return <ProjectSelector workspace={workspace} teamScoped={scope.requestedProject === null} />;
}
