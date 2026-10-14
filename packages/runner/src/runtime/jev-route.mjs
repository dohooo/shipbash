// What a Journey's newest passing walk did next, at the walk's place in that
// walk (the route its opening carries, contracts runtime/walk-route.mjs),
// brought into Jev's options for the page: the option that acts as that walk
// did is marked, a value it typed or picked that the steps do not quote is
// offered on the same control, and a page it opened from here by URL is
// offered by its title. On a
// page Jev must not act on (a password field, too many controls), only opens
// are offered — of a page the walk opened from here, or reached from here by
// clicking: they leave the page without touching anything on it. Jev still chooses, the step ledger still attributes and may refuse,
// and every checkpoint is read from the page as before: the route says how the
// walk went, never whether a checkpoint held.
import { routePath } from "@shipbash/contracts/runtime/walk-route.mjs";
import { browserOption, parseControls } from "./jev-target.mjs";

const MARK = " — the newest passing walk of this Journey did this here";
const TOOLS = {
  click: "agent_browser_click",
  fill: "agent_browser_fill",
  select: "agent_browser_select",
  check: "agent_browser_check",
  uncheck: "agent_browser_uncheck",
  open: "agent_browser_open",
};

// The roles a selector's tag may stand for (contracts walk-route.mjs TAG_ROLES): an input is a textbox or a searchbox.
const ROLE_FAMILIES = { textbox: new Set(["textbox", "searchbox", "combobox", "spinbutton"]) };

/** The one control the page names by this role ("*": any) and name, or null when it names none or several. */
function soleControl(controls, role, name) {
  const fits = (item) => role === "*" || item.role === role || ROLE_FAMILIES[role]?.has(item.role);
  const matches = controls.filter((item) => item.ref && fits(item) && item.label === name);
  return matches.length === 1 ? matches[0] : null;
}

/** Whether an option does what the route's action did, to this control. */
function actsAs(option, action, control) {
  if (option.tool !== TOOLS[action.verb] || option.args?.selector !== `@${control.ref}`) return false;
  if (action.verb === "fill") return option.args.text === action.value;
  if (action.verb === "select") return option.args.values?.[0] === action.value;
  return true;
}

/** The option a remembered fill or select becomes when the steps quote no value for it. */
function remembered(action, control, index) {
  const selector = `@${control.ref}`;
  const label = JSON.stringify(control.label);
  const value = JSON.stringify(action.value);
  if (action.verb === "fill") {
    return {
      ...browserOption(`recall_fill_${control.ref}_${index}`, `Fill ${label} with ${value}${MARK}`, TOOLS.fill, { selector, text: action.value }),
      summary: `Fill ${label} with the value the newest passing walk typed`,
      // The step ledger lets it stand for a step's unquoted text (jev-steps.mjs refuse).
      remembered: true,
    };
  }
  return browserOption(`recall_select_${control.ref}_${index}`, `Select ${value} in ${label}${MARK}`, TOOLS.select, { selector, values: [action.value] });
}

/** The option a remembered open becomes, unless it would open the page the walk is already on. */
function reopened(action, url, index) {
  const target = new URL(action.value, url);
  if (target.href === new URL(url).href) return null;
  const page = action.name ? `the page ${JSON.stringify(action.name)}` : "the page";
  return browserOption(`recall_open_${index}`, `Open ${page} at ${action.value}${MARK}`, TOOLS.open, { url: target.href });
}

/** An open of the page an action led to from here: what Jev may do on a page it must not act on. */
function leaving(action, url, index) {
  if (action.verb === "open") return reopened(action, url, index);
  if (!action.to) return null;
  const target = new URL(action.to.path, url);
  const page = action.to.title ? `the page ${JSON.stringify(action.to.title)}` : "the page";
  const how = `${action.verb} ${action.role} ${JSON.stringify(action.name)}`;
  return browserOption(`recall_reach_${index}`, `Open ${page} at ${action.to.path}, which the newest passing walk of this Journey reached from here (${how})`, TOOLS.open, { url: target.href });
}

/**
 * On a page Jev must not act on, every page the route left it for, from the
 * walk's place on, one option per page: leaving touches nothing, and Jev picks
 * the one its step is after. Null when the route left it for none.
 */
function leavings(url, route, next, path) {
  const opens = new Map();
  for (let index = next; index < (route?.length ?? 0); index += 1) {
    const option = route[index].path === path ? leaving(route[index], url, index) : null;
    if (option && !opens.has(option.args.url)) opens.set(option.args.url, { ...option, routeIndex: index });
  }
  return opens.size ? [...opens.values()] : null;
}

/**
 * The route action as an option on this page, from the controls and options
 * Jev has: the option that acts as the walk did, marked; or the remembered
 * fill, select or open; or null when the page does not offer it.
 */
function asOption(action, index, options, controls, url) {
  if (action.verb === "open") return reopened(action, url, index);
  const control = soleControl(controls, action.role, action.name);
  if (!control) return null;
  const same = options.find((option) => actsAs(option, action, control));
  if (same) return typeof same.description === "string" ? { ...same, description: `${same.description}${MARK}` } : same;
  return action.verb === "fill" || action.verb === "select" ? remembered(action, control, index) : null;
}

/**
 * This page's options with the route's next action on it. The route is walked
 * in order: from `next`, the walk's place in it, the first action taken on
 * this page that the page offers is the one marked or offered (an action the
 * page no longer offers, a closed banner, is passed over), and only that one,
 * so a walk never takes a later action before an earlier one. The option
 * carries its place (`routeIndex`), and taking it moves the walk on.
 * @param {import("./jev-target.mjs").JevOption[] | null} options pageOptions' for the page, null when Jev must not act on it
 * @param {{ page: string, url: string }} state
 * @param {import("@shipbash/contracts/runtime/walk-route.mjs").RouteAction[]} route
 * @param {number} next the place in the route after the last route action the walk took
 * @returns the options, or null when Jev must not act on the page and the route leaves it nowhere
 */
export function withRoute(options, state, route, next = 0) {
  const path = routePath(state.url);
  if (!options) return leavings(state.url, route, next, path);
  const controls = parseControls(state.page);
  for (let index = next; index < (route?.length ?? 0); index += 1) {
    const action = route[index];
    if (action.path !== path) continue;
    const option = asOption(action, index, options, controls, state.url);
    if (!option) continue;
    const placed = { ...option, routeIndex: index };
    // A marked option keeps its place among the page's; an offered one comes after them.
    return options.some((each) => each.ref === placed.ref)
      ? options.map((each) => (each.ref === placed.ref ? placed : each))
      : [...options, placed];
  }
  return options;
}

