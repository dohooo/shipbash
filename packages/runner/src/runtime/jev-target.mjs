// Offer current browser controls as closed options and validate Jev's choice among them.
export const JEV_MODEL = "jev-1.13.0";

// A native select or listbox with more choices than this offers only the
// choices the Journey quotes: a country list must not crowd out the page.
const OPEN_CHOICES = 12;
// What a choice belongs to: a radio its group, an option its list or select.
const OWNERS = {
  radio: new Set(["radiogroup", "group"]),
  option: new Set(["listbox", "combobox"]),
};

/**
 * @typedef {{ ref: string, description: string | Record<string, string>, summary?: string, tool?: string, args?: Record<string, unknown> }} JevOption
 * @typedef {{ role: string, label: string, ref: string | null, attrs: string[], value: string, depth: number, parent: Control | null, native: boolean }} Control
 * The page a control is read on: every control, the Journey's quoted values,
 * and whether lists offer only the choices those values name.
 * @typedef {{ controls: Control[], values: ReadonlyArray<string>, quotedOnly: boolean }} Page
 */

export function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function unquote(text) {
  try {
    return JSON.parse(`"${text}"`).trim();
  } catch {
    return text.trim();
  }
}

/** One snapshot line as a node of the outline, or null for prose and continuation lines. */
function parseLine(line) {
  const match = line.match(/^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/u);
  if (!match) return null;
  const [, indent, role, label = "", rest] = match;
  const attrs = [...rest.matchAll(/\[([^\]]*)\]/gu)].flatMap((group) => group[1].split(/,\s*/u));
  const ref = attrs.find((item) => /^ref=e\d+$/u.test(item))?.slice(4) ?? null;
  return {
    role,
    label: unquote(label),
    ref,
    attrs,
    value: rest.match(/\]: (.*)$/u)?.[1]?.trim() ?? "",
    depth: indent.length,
  };
}

/** The snapshot outline with each node's enclosing node; a native select owns a MenuListPopup. */
export function parseControls(snapshot) {
  /** @type {Control[]} */
  const controls = [];
  /** @type {Control[]} */
  const stack = [];
  for (const line of snapshot.split("\n")) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    while (stack.length && stack.at(-1).depth >= parsed.depth) stack.pop();
    const control = { ...parsed, parent: stack.at(-1) ?? null, native: false };
    if (control.role === "MenuListPopup" && control.parent?.role === "combobox") control.parent.native = true;
    stack.push(control);
    controls.push(control);
  }
  return controls;
}

const state = (control, key) => control.attrs.find((item) => item.startsWith(`${key}=`))?.slice(key.length + 1);
const flagged = (control, flag) => control.attrs.includes(flag);
const quoted = (text) => JSON.stringify(text);
const normalized = (text) => text.replace(/\s+/gu, " ").trim().toLowerCase();
const quotes = (page, text) => page.values.some((value) => normalized(value) === normalized(text));

/** The nearest enclosing group, list or select a radio or option belongs to. */
function owner(control) {
  for (let node = control.parent; node; node = node.parent) {
    if (OWNERS[control.role].has(node.role)) return node;
  }
  return null;
}

const within = (control) => {
  const label = owner(control)?.label;
  return label ? ` in ${quoted(label)}` : "";
};

/** @returns {JevOption} */
export function browserOption(ref, description, tool, args) {
  return { ref, description, tool, args };
}

const click = (control, description) =>
  browserOption(`click_${control.ref}`, description, "agent_browser_click", { selector: `@${control.ref}` });

/** A checkbox or switch offers the state it is not in; mixed counts as not checked. */
function toggle(control) {
  const on = state(control, "checked") === "true";
  const [check, uncheck] = control.role === "switch" ? ["Turn on", "Turn off"] : ["Check", "Uncheck"];
  const verb = on ? "uncheck" : "check";
  const description = `${on ? uncheck : check} ${control.role} ${quoted(control.label)}`;
  return [browserOption(`${verb}_${control.ref}`, description, `agent_browser_${verb}`, { selector: `@${control.ref}` })];
}

/** A radio or radio menu item offers only being chosen, never being cleared. */
function choose(control) {
  if (state(control, "checked") === "true") return [];
  if (control.role === "menuitemradio") return [click(control, `Choose menu item ${quoted(control.label)}`)];
  const description = `Choose radio ${quoted(control.label)}${within(control)}`;
  return [browserOption(`check_${control.ref}`, description, "agent_browser_check", { selector: `@${control.ref}` })];
}

function menuToggle(control) {
  const on = state(control, "checked") === "true";
  return [click(control, `Turn ${on ? "off" : "on"} menu item ${quoted(control.label)}`)];
}

/** A select's or listbox's unselected, enabled choices; a long list, or a crowded page, offers only quoted ones. */
function choices(list, page) {
  const open = page.controls.filter(
    (item) =>
      item.role === "option" && item.ref && owner(item) === list && !flagged(item, "selected") && !flagged(item, "disabled"),
  );
  return !page.quotedOnly && open.length <= OPEN_CHOICES ? open : open.filter((item) => quotes(page, item.label));
}

/** A native select is set per choice; a custom combobox is opened, and its listbox offers the choices. */
function combobox(control, page) {
  const current = control.value ? ` (currently ${quoted(control.value)})` : "";
  if (!control.native) {
    return state(control, "expanded") === "true"
      ? []
      : [click(control, `Open combobox ${quoted(control.label)}${current}, the first step of setting it`)];
  }
  return choices(control, page).map((item) =>
    browserOption(
      `select_${control.ref}_${item.ref}`,
      `Select ${quoted(item.label)} in ${quoted(control.label)}${current}`,
      "agent_browser_select",
      { selector: `@${control.ref}`, values: [item.label] },
    ),
  );
}

function listOption(control, page) {
  const list = owner(control);
  if (list?.native || !choices(list, page).includes(control)) return [];
  return [click(control, `Choose option ${quoted(control.label)}${within(control)}`)];
}

/** Fill only quoted values the field does not already hold; Enter submits a field holding one. */
function text(control, page) {
  const selector = `@${control.ref}`;
  const fills = [...page.values.entries()]
    .filter(([, value]) => value !== control.value)
    .map(([index, value]) => ({
      ...browserOption(`fill_${control.ref}_${index}`, `Fill ${quoted(control.label)} with ${quoted(value)}`, "agent_browser_fill", {
        selector,
        text: value,
      }),
      summary: `Fill ${quoted(control.label)} with Journey value ${index + 1}`,
    }));
  if (!page.values.includes(control.value)) return fills;
  const enter = browserOption(`enter_${control.ref}`, `Press Enter in ${control.role} ${quoted(control.label)}`, "agent_browser_batch", {
    calls: [
      { tool: "agent_browser_focus", args: { selector } },
      { tool: "agent_browser_press", args: { key: "Enter" } },
    ],
  });
  return [...fills, enter];
}

const plainClick = (control) => [click(control, `Click ${control.role} ${quoted(control.label)}`)];
/** The options each offered role builds. @type {Record<string, (control: Control, page: Page) => JevOption[]>} */
const BUILDERS = {
  button: plainClick,
  link: plainClick,
  tab: plainClick,
  menuitem: plainClick,
  checkbox: toggle,
  switch: toggle,
  radio: choose,
  menuitemradio: choose,
  menuitemcheckbox: menuToggle,
  combobox,
  option: listOption,
  textbox: text,
  searchbox: text,
  spinbutton: text,
};

/** Escape closes what is open: a dialog, or a menu, list or disclosure that says it is expanded. */
function escapeOption(controls) {
  const open = controls.some((item) => item.role === "dialog" || item.role === "alertdialog" || state(item, "expanded") === "true");
  return open
    ? [browserOption("press_escape", "Press Escape to close the open dialog, menu or list", "agent_browser_press", { key: "Escape" })]
    : [];
}

/**
 * Every action the current page offers, in page order, each named by the
 * outcome it produces: a control already in a state offers only leaving it.
 * Values typed are only the Journey's quoted ones, and past `limit` options
 * a list offers only the choices they name. Page instructions, field values
 * and unlabelled or disabled controls are never offered.
 * @param {string} snapshot
 * @param {ReadonlyArray<string>} values
 * @param {number} [limit]
 * @returns {JevOption[]}
 */
export function elementOptions(snapshot, values, limit = Infinity) {
  const controls = parseControls(snapshot);
  const offered = controls.filter((item) => item.ref && item.label && Object.hasOwn(BUILDERS, item.role) && !flagged(item, "disabled"));
  if (offered.some((item) => item.label.length > 300)) return [];
  const refs = controls.map((item) => item.ref).filter(Boolean);
  if (new Set(refs).size !== refs.length) return [];
  const build = (quotedOnly) => [
    ...offered.flatMap((item) => BUILDERS[item.role](item, { controls, values, quotedOnly })),
    ...escapeOption(controls),
  ];
  const options = build(false);
  return options.length > limit ? build(true) : options;
}

/** A Noul answer's probability of yes, or null when the answer is not a valid one. */
export function acceptedNoul(response, question) {
  const answer = response?.answers?.[question];
  if (response?.model !== JEV_MODEL || answer?.type !== "noul" || !isProbability(answer.noul)) return null;
  return answer.noul;
}

/** Validate one choice answer before an identifier can reach the browser. */
export function acceptedChoice(response, question, candidates) {
  const answer = response?.answers?.[question];
  if (response?.model !== JEV_MODEL || answer?.type !== "choice") return null;
  if (!isProbability(answer.confidence)) return null;
  const keys = ["none", ...candidates.map((item) => item.ref)];
  if (!keys.includes(answer.choice)) return null;
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== keys.length) return null;
  if (keys.some((key) => !isProbability(probabilities[key]))) return null;
  if (Math.abs(keys.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.01 + Number.EPSILON) return null;
  // Rank, not an uncalibrated confidence cutoff, determines the next action.
  // Ties with explicit abstention stay with the supervising agent.
  const selected = keys.reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best), "none");
  return selected === "none" ? null : selected;
}
