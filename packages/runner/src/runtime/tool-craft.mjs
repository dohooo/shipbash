// The browser craft that used to ride every system prompt, delivered where
// it applies instead: appended to each tool's own description as the proxy
// forwards tools/list. A lesson sitting on the tool it teaches is read at the
// moment of use; the same lesson in a wall of rules was retrieved never.
const STALE_REF =
  "Refs like @e1 belong to the snapshot that produced them and die on any page change; act from the freshest appended snapshot, and when a ref fails, take the element's ref from a fresh snapshot instead of guessing another ref.";
const COVERED_CLICK =
  "A refused click names the layer that would receive it — a covered click names its own fix: dismiss the banner or modal that owns those pixels, then click again. When every action suddenly does nothing, a confirm() or prompt() dialog is suspending the page — resolve it before concluding anything about the product.";
// A confirmation control that a click reveals — Confirm delete, Are you
// sure — is armed for seconds and snaps back: the agent's click, snapshot,
// click sequence lost the window repeatedly (a target product's OAuth apps and
// a project). The lesson applies only once the snapshot after a
// click has shown such a control — a speculative second press on a button
// that has no confirmation would be a double send — and the control has no
// ref yet inside the batch, so it is located by its text. That product's Confirm
// delete held for 4–8 s and a turn between the clicks
// takes 4–5 s of it; inside the batch the confirmation landed 0.7 s after the
// click that revealed it (runner image, gate and cursor lead included).
export const CONFIRM_WINDOW =
  "When the page after a click shows a confirmation control (Confirm delete, Are you sure) that snaps back before your next click, redo the pair in one agent_browser_batch: the original click, then a click on the confirmation by an XPath selector on its text, such as xpath=//button[normalize-space()='Confirm delete'], since it has no ref yet. The batch's last result shows the page after the pair. Never batch a second press on the same control speculatively.";
// reachability.mjs refuses eval code that invokes page handlers.
const EVAL_READS =
  "Here eval reads the page: a script that calls .click(), .submit(), or dispatchEvent() is refused, because it skips the checks a real user's action passes — act through the interaction tools.";
const STUBBORN_FIELD =
  "A field still empty afterwards is a custom component ignoring synthetic input: focus it and type through the keyboard tools instead.";
const MISSING_ELEMENT =
  "An element you can see but cannot find here is usually below the fold or not yet rendered: scroll toward it or wait for its text, then read again. Iframes are inlined and their refs work directly.";
// What a wait should wait for. A text
// wait matches the page's own innerText as a raw substring, so a sentence
// lifted from the accessibility snapshot — which folds whitespace — may never
// match; and text the page already shows cannot detect a redirect.
const TEXT_WAIT =
  "Text waits match a short distinctive fragment of the page text; a whole sentence copied from the snapshot may wrap across lines in the DOM. To wait for a redirect after sign-in, wait with agent_browser_wait_for_url on the destination — never on text the current page already shows.";
const URL_WAIT =
  "The right wait for a redirect: give the destination pattern (for example **/dashboard) and a waitTimeoutMs of a few seconds. When the destination is unknown, use agent_browser_wait_for_selector on an element only the signed-in page shows.";
// A URL handed to the agent as text. A
// person given "visit: <url>" by a CLI gets a new window and keeps the product
// where it was, and the agent does the same instead of navigating the
// product's own tab away to it.
// The live view (screencast-sidecar.mjs, chooseTarget) follows the newest open
// tab and cannot see an agent tab switch, so a finished side step is closed,
// not merely switched away from. tab_close without an id closes the tab in
// front — spelled out, since the obvious sequence (switch back, then bare
// tab_close) would close the product.
// A page a program in the terminal opens arrives as a tab of
// its own, in front and unlabelled (terminal-lane.mjs openUrl).
// A step that tells the agent to open a URL is the same
// lesson. read opens nothing (agent-browser-catalogue.mjs), and a tab already
// on the address shows the page as it loaded: a walk judged a tab
// loaded before the CLI finished onboarding. tab_switch and tab_close now come
// back with the page left in front (agent-browser-downstream.mjs).
// agent_browser_open is the current tab's address
// bar (agent-browser-catalogue.mjs). Which of the two takes a URL is one
// sentence on both tools, so the two never tell it apart differently.
// Playwright MCP draws the same line (browser_navigate, browser_tabs new), as
// does agent-browser's own CLI (open, tab new).
export const URL_SPLIT =
  "An address the flow you are walking goes to next — a URL a Journey step names, or the product's signed-in entry point — loads in the current tab with agent_browser_open; a URL something else hands you, as text you would have to type — a CLI's \"visit:\" line, an email, a device-code or install page the product names — opens in a tab of its own with agent_browser_tab_new, the way a person gets a new window, and so does any address whose page must not replace the one in front.";
const NEW_TAB_FACTS =
  "A new tab loads its page fresh, while a tab already on that address shows the page as it was when it loaded. When the side step is done, close the side tab by its label or id with agent_browser_tab_close — not the product's tab. A page a program in the terminal opened (a terminal answer's openedInBrowser) is already in front in its own tab: never open it again, and close it by its id from agent_browser_tab_list, since it has no label.";
const PRODUCT_LINK = "A link or button the product offers is clicked as a person would, not loaded by its address.";
// agent-browser 0.38.1 answers tab_new with the new tab's URL as its text; the
// tab id rides only in structuredContent, which the agent never reads.
const SIDE_TAB =
  "The new tab becomes the active page for snapshots and screenshots until you close it or switch; this call returns only the new tab's URL — no snapshot and no tab id — so give it a label to switch to or close it by, and take a snapshot before acting there. The product's own tab stays open underneath — that is where the flow continues afterwards.";
const SWITCH_BACK =
  "Switching moves your snapshots and actions to that tab, and the live view the owner watches follows the tab in front of the browser window; a finished side step is still closed with agent_browser_tab_close rather than switched away from, so stale tabs do not crowd agent_browser_tab_list and you and the view return to the product's tab together.";
const CLOSE_SIDE =
  "Without `tab` this closes the tab you are on; when the product's tab is in front, pass the side tab's label, or its id from agent_browser_tab_list, as `tab`. Close only a side tab you opened for a handed URL — closing the product's own tab ends the flow. The result carries the page now in front, its URL first: that is where the product stands.";

export const TOOL_CRAFT = Object.freeze({
  agent_browser_click: `${STALE_REF} ${COVERED_CLICK} ${CONFIRM_WINDOW}`,
  agent_browser_dblclick: `${STALE_REF} ${COVERED_CLICK}`,
  agent_browser_eval: EVAL_READS,
  agent_browser_check: STALE_REF,
  agent_browser_uncheck: STALE_REF,
  agent_browser_select: STALE_REF,
  agent_browser_fill: STUBBORN_FIELD,
  agent_browser_type: STUBBORN_FIELD,
  agent_browser_snapshot: MISSING_ELEMENT,
  agent_browser_open: `${URL_SPLIT} ${PRODUCT_LINK}`,
  agent_browser_tab_new: `${URL_SPLIT} ${NEW_TAB_FACTS} ${SIDE_TAB}`,
  agent_browser_tab_switch: SWITCH_BACK,
  agent_browser_tab_close: CLOSE_SIDE,
  agent_browser_wait_for_text: TEXT_WAIT,
  agent_browser_wait_for_url: URL_WAIT,
});

/** Appends each tool's craft note to its description; unknown tools pass untouched. */
export function decorateToolDescriptions(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    const craft = tool && typeof tool.name === "string" ? TOOL_CRAFT[tool.name] : undefined;
    if (!craft) return tool;
    const description = typeof tool.description === "string" && tool.description.trim()
      ? `${tool.description.trim()} ${craft}`
      : craft;
    return { ...tool, description };
  });
}
