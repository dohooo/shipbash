/**
 * Every pane of the Settings hub, and the groups its column draws them in.
 *
 * A pane IS its address — `/settings/<key>` — so this one table answers the
 * route, the page title, the column's label and the crumb, and nothing spells a
 * pane's name twice. It holds no components on purpose: the route files read it
 * on the server for `generateMetadata` and for refusing a segment that names no
 * pane, while `settings-pane-bodies` keeps the bodies on the client.
 */
/** The optional integrations a deployment serves, as its session reports them. */
export interface OfferedIntegrations {
  slack: boolean;
  github: boolean;
}

/**
 * A pane's label, the brand mark its nav row carries when the thing it
 * configures has one, and the integration it needs, when the deployment may
 * leave that out. Both are data here rather than branches in the column, so
 * the next integration is one more row and nothing else.
 */
export const SETTINGS_PANES = {
  "sign-ins": { label: "Sign-ins", mark: null, needs: null },
  members: { label: "Members", mark: null, needs: null },
  usage: { label: "Usage", mark: null, needs: null },
  project: { label: "General", mark: null, needs: null },
  alerts: { label: "Alerts", mark: null, needs: "slack" },
  slack: { label: "Slack", mark: "/slack-color.svg", needs: "slack" },
  github: { label: "GitHub", mark: "/github.svg", needs: "github" },
} as const satisfies Record<string, { label: string; mark: string | null; needs: keyof OfferedIntegrations | null }>;

export type SettingsPane = keyof typeof SETTINGS_PANES;

/** The pane Settings opens on: where the rail, the trail and the bare address all lead. */
export const DEFAULT_SETTINGS_PANE: SettingsPane = "sign-ins";

export function isSettingsPane(segment: string): segment is SettingsPane {
  return Object.hasOwn(SETTINGS_PANES, segment);
}

/** Whether the deployment offers the pane: an integration's only where it is configured. */
export function paneOffered(pane: SettingsPane, integrations: OfferedIntegrations): boolean {
  const { needs } = SETTINGS_PANES[pane];
  return needs === null || integrations[needs];
}

interface SettingsGroup {
  heading: string;
  panes: readonly SettingsPane[];
}

const TEAM_GROUP: SettingsGroup = { heading: "Team", panes: ["sign-ins", "members", "usage"] };

/**
 * The product the switcher has selected — one entry, never a flat list of
 * every product the team has: that works at three and fails at thirty, and a
 * product's settings are reached through the product everywhere else.
 */
const PROJECT_GROUP: SettingsGroup = { heading: "Project", panes: ["project", "alerts"] };

/**
 * One entry per service, at team scope: Slack issues one token per workspace
 * per install, and a GitHub account is one installation, so three projects
 * using the same one are one connection and not three. It is drawn whether or
 * not a project is selected.
 */
const INTEGRATIONS_GROUP: SettingsGroup = { heading: "Integrations", panes: ["slack", "github"] };

/**
 * A team that verifies nothing yet has no product group to point anywhere,
 * and a group holds only the panes the deployment offers.
 */
export function settingsGroups(product: boolean, integrations: OfferedIntegrations): readonly SettingsGroup[] {
  return (product ? [TEAM_GROUP, PROJECT_GROUP, INTEGRATIONS_GROUP] : [TEAM_GROUP, INTEGRATIONS_GROUP])
    .map((group) => ({ ...group, panes: group.panes.filter((pane) => paneOffered(pane, integrations)) }))
    .filter((group) => group.panes.length > 0);
}

/**
 * The addresses Settings occupies: the hub's own, and one per pane. The shell
 * reads this to place Settings among the sections that carry the scope they are
 * read in, so it never has to know what a pane is called.
 */
export const SETTINGS_SECTIONS: ReadonlySet<string> = new Set([
  "/settings",
  ...Object.keys(SETTINGS_PANES).map((pane) => `/settings/${pane}`),
]);
