// The CDP conversation with the human-auth viewer: the shared capture
// (browser-state-capture.mjs) bound to the viewer's own Chromium, with each
// page's reading of what it shows riding the same evaluate as its storage.
// Pure of any file I/O; the capture and the anonymous baseline both read
// through here.
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

import { captureBrowserState, cdpCommand as command, cdpEndpoints } from "../browser-state-capture.mjs";

import { PAGE_READING_FIELDS, pageReadingFrom } from "./human-auth-page.mjs";

const LABEL = "human-auth";
// The viewer's browser: its CDP address, from its launch or relaunch (human-auth-lane.mjs).
let viewerCdpUrl = null;

/** Every CDP read of the viewer goes to this browser from here on. */
export function useViewerBrowser(cdpUrl) {
  viewerCdpUrl = cdpUrl;
}

/** The viewer's browser-wide CDP socket. */
export function viewerBrowserCdpUrl() {
  if (!viewerCdpUrl) throw new Error("The sign-in browser is not running.");
  return viewerCdpUrl;
}

/** The HTTP side of the viewer's CDP endpoint (/json/list, /json/version). */
function baseUrl() {
  return `http://${new URL(viewerBrowserCdpUrl()).host}`;
}

export function cdpCommand(webSocketUrl, method, params = {}) {
  return command(webSocketUrl, method, params, { label: LABEL });
}

export async function pageTargets() {
  const response = await fetch(`${baseUrl()}/json/list`);
  if (!response.ok) return [];
  const targets = await response.json();
  return Array.isArray(targets)
    ? targets.filter((target) =>
        isRecord(target)
        && target.type === "page"
        && typeof target.webSocketDebuggerUrl === "string")
    : [];
}

/** The viewer's browser-wide socket and raw target list; see cdpEndpoints. */
export function humanAuthCdpEndpoints() {
  return cdpEndpoints(baseUrl(), LABEL);
}

/**
 * The viewer's state, what each page showed for the product-page verdict,
 * and the hosts of the pages that did not answer in time. Options are the
 * capture's (`pageTimeoutMs`).
 *
 * @returns {Promise<{ state: unknown, pages: ReturnType<typeof pageReadingFrom>[], unanswered: string[] }>}
 */
export async function humanAuthStateFromCdp(options = {}) {
  const { state, answers, unanswered } = await captureBrowserState(baseUrl(), { label: LABEL, pageFields: PAGE_READING_FIELDS, ...options });
  return { state, pages: answers.map((answer) => pageReadingFrom(answer)), unanswered };
}
