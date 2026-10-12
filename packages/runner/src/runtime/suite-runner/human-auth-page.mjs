// What the takeover browser's product page looked like when the capture
// sealed it: still a sign-in surface, or past it. This is the judge of the
// sign-in ruler (contracts/runtime/sign-in-scope.mjs): the cookies cannot
// tell a session from what a visitor gets before signing in, the page can
// (a target product: the product still on /sign-in).
//
// Each page is read over CDP (the viewer's Chromium has no agent-browser
// daemon to snapshot it) as rows in the interactive snapshot's own shape, and
// Jev judges them as it judges the Activity lane's frames (page-kind.mjs).
// Every doubt Jev answered falls toward "still a sign-in surface": that side
// costs the person one more sign-in, the other side seals a state that signs
// nobody in. A page Jev did not judge asserts nothing either way; its host is
// reported unanswered, like a page that did not answer the capture in time.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";
import { hostOf, publicPageUrl, registrableDomain } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { judgmentSignal, needsOwner } from "../page-kind.mjs";

const MAX_ELEMENTS = 100;

/**
 * In the page: its visible, named headings and controls as `- role "name"`
 * rows, in document order, inside the open modal when there is one (the page
 * beneath is inert, as the snapshot shows it). A field is named by its label,
 * never its value.
 */
export const PAGE_ELEMENTS_EXPRESSION = `(() => {
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 120).replace(/"/g, "'");
  const label = (node) => clean(node.getAttribute("aria-label") || (node.labels && node.labels[0] ? node.labels[0].innerText : "") || node.getAttribute("placeholder") || node.getAttribute("title") || node.getAttribute("name"));
  const text = (node) => clean(node.getAttribute("aria-label") || node.innerText || (node.tagName === "INPUT" ? node.value : "") || node.getAttribute("title"));
  const plain = ["", "text", "email", "password", "tel", "url", "number"];
  const describe = (node) => {
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute("type") || "").toLowerCase();
    const role = node.getAttribute("role") || "";
    if (/^h[1-3]$/.test(tag)) return 'heading "' + text(node) + '" [level=' + tag[1] + "]";
    if (role === "button" || tag === "button" || (tag === "input" && ["submit", "button", "reset"].includes(type))) return 'button "' + text(node) + '"';
    if (role === "link" || tag === "a") return 'link "' + text(node) + '"';
    if (role === "tab") return 'tab "' + text(node) + '"';
    if (role === "checkbox" || role === "switch" || (tag === "input" && type === "checkbox")) return 'checkbox "' + label(node) + '"';
    if (tag === "input" && type === "radio") return 'radio "' + label(node) + '"';
    if (role === "combobox" || tag === "select") return 'combobox "' + label(node) + '"';
    if (role === "searchbox" || (tag === "input" && type === "search")) return 'searchbox "' + label(node) + '"';
    if (role === "textbox" || tag === "textarea" || (tag === "input" && plain.includes(type))) return 'textbox "' + label(node) + '"';
    return null;
  };
  const root = document.querySelector("dialog:modal, [aria-modal=true]") || document;
  const rows = [];
  for (const node of root.querySelectorAll("h1, h2, h3, a[href], button, input, textarea, select, [role]")) {
    if (rows.length >= ${String(MAX_ELEMENTS)}) break;
    if (node.closest("[inert], [aria-hidden=true]") || node.getClientRects().length === 0) continue;
    const row = describe(node);
    if (row && row.indexOf(' ""') === -1) rows.push("- " + row);
  }
  return rows;
})()`;

// The fields each page is asked for beside its local storage.
export const PAGE_READING_FIELDS =
  `href: location.href, title: document.title, readyState: document.readyState, elements: ${PAGE_ELEMENTS_EXPRESSION}`;

/**
 * One page's reading out of the parsed Runtime.evaluate answer, or null when
 * the page did not answer with the fields (a navigation mid-capture).
 *
 * @param {unknown} payload The parsed answer.
 * @returns {{ href: string, title: string, readyState: string, elements: string[] } | null}
 */
export function pageReadingFrom(payload) {
  if (!isRecord(payload) || typeof payload.href !== "string") return null;
  return {
    href: payload.href,
    title: typeof payload.title === "string" ? payload.title : "",
    readyState: typeof payload.readyState === "string" ? payload.readyState : "",
    elements: Array.isArray(payload.elements)
      ? payload.elements.filter((entry) => typeof entry === "string").slice(0, MAX_ELEMENTS)
      : [],
  };
}

/**
 * The product's page at capture: any page on the product's site past its
 * sign-in surface vouches for the capture; with none open there is nothing
 * to vouch, and with only sign-in surfaces open the verdict says so. Pages
 * Jev did not judge come back as `unjudged` hosts, never as a verdict.
 *
 * @param {ReturnType<typeof pageReadingFrom>[]} readings Every page's reading, nulls included.
 * @param {string} productionUrl The URL the takeover opened on.
 * @param {(frame: { url: string, title: string, snapshotText: string }) => Promise<import("../page-kind.mjs").PageJudgment>} judge
 * @returns {Promise<{ verdict: { url: string, signInSurface: boolean, signals: string[] } | null, unjudged: string[] }>}
 */
export async function productPageVerdict(readings, productionUrl, judge) {
  const productSite = registrableDomain(hostOf(productionUrl));
  const pages = readings.filter((reading) => reading !== null && registrableDomain(hostOf(reading.href)) === productSite);
  if (productSite.length === 0 || pages.length === 0) return { verdict: null, unjudged: [] };
  const judged = await Promise.all(pages.map(async (reading) => ({
    reading,
    judgment: await judge({ url: reading.href, title: reading.title, snapshotText: reading.elements.join("\n") }),
  })));
  const answered = judged.filter(({ judgment }) => judgment.kind !== null);
  const unjudged = judged.filter(({ judgment }) => judgment.kind === null).map(({ reading }) => hostOf(reading.href));
  const chosen = answered.find(({ judgment }) => !needsOwner(judgment)) ?? answered[0];
  if (!chosen) return { verdict: null, unjudged };
  return {
    verdict: { url: publicPageUrl(chosen.reading.href), signInSurface: needsOwner(chosen.judgment), signals: [judgmentSignal(chosen.judgment)] },
    unjudged,
  };
}
