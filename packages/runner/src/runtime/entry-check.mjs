// The entry check: a terminal conclusion needs two pieces of evidence, and
// code enforces it. An agent can stand on a sign-in page that still renders
// its form — or on the marketing root — with a valid session in its browser
// (the target's request log shows the signed-in user) and conclude "sign-in
// did not persist" or "no workspace entry point", filing another takeover or
// a blocked verdict. A rule to open the entry once before judging, kept only
// in prose, was ignored.
//
// This is the gate at the two acceptance points: the Activity lane's
// request_authentication and deliver_result(auth_required) tool calls
// (pi-tooling.mjs) and the case lane's report_checklist blocked transition
// (progress-tools.mjs). The rule: when this leg loaded a sign-in state and
// every page seen so far is a doorstep page — the production root or a
// sign-in surface — the FIRST such conclusion is refused with the concrete
// thing to try; the second is accepted regardless. One refusal per leg, never
// a trap. A leg with no page record refuses nothing: withholding a conclusion
// takes evidence, and there is none.

const KNOWN_ENTRY_LIMIT = 3;
// The gate sees only the addresses the leg visited, never the pages, so a
// sign-in surface is recognised here by its path.
const SIGN_IN_PATH_PATTERN =
  /(^|\/)(login|log-in|signin|sign-in|sign_in|sso|auth|authorize|authenticate|sessions?\/new|users\/sign_in|account\/login|oauth|wp-login)(\.\w+)?(\/|$)/iu;

/** @param {unknown} value */
function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** @param {string} pathname */
function trimmedPath(pathname) {
  return pathname.replace(/\/+$/u, "") || "/";
}

/** origin + pathname — a page's identity on the record (no query, no hash). */
export function pageOf(url) {
  const parsed = httpUrl(url);
  return parsed ? `${parsed.origin}${parsed.pathname}` : null;
}

/**
 * A page that proves nothing about a saved session: the production root, or
 * a sign-in surface on any host. A URL that is not a web page (about:blank)
 * is no evidence either.
 * @param {string} url
 * @param {string} productionUrl
 */
export function isDoorstepPage(url, productionUrl) {
  const page = httpUrl(url);
  if (!page) return true;
  if (SIGN_IN_PATH_PATTERN.test(page.pathname)) return true;
  const root = httpUrl(productionUrl);
  return root !== null && page.origin === root.origin && trimmedPath(page.pathname) === trimmedPath(root.pathname);
}

/**
 * True when nothing beyond the doorstep has been seen yet.
 * @param {readonly string[]} pagesSeen
 * @param {string} productionUrl
 */
export function onlyDoorstepSeen(pagesSeen, productionUrl) {
  return pagesSeen.every((url) => isDoorstepPage(url, productionUrl));
}

/**
 * The signed-in entries the project already knows: page-index keys
 * (host/path, ids as :id — harness-notes.mjs) on the production host that
 * are not doorstep pages, as URLs with the first note's title.
 * @param {Map<string, Array<{ title?: unknown }>> | null} pageIndex
 * @param {string} productionUrl
 * @returns {string[]}
 */
export function knownEntriesFrom(pageIndex, productionUrl) {
  const root = httpUrl(productionUrl);
  if (!root || !pageIndex) return [];
  const entries = [];
  for (const [key, notes] of pageIndex) {
    const slash = key.indexOf("/");
    const host = slash === -1 ? key : key.slice(0, slash);
    const path = slash === -1 ? "/" : key.slice(slash);
    if (host !== root.host.toLowerCase() || path.includes(":id")) continue;
    const url = `${root.protocol}//${host}${path}`;
    if (isDoorstepPage(url, productionUrl)) continue;
    const title = typeof notes[0]?.title === "string" ? notes[0].title.trim() : "";
    entries.push(title ? `${url} (${title})` : url);
    if (entries.length === KNOWN_ENTRY_LIMIT) break;
  }
  return entries;
}

/**
 * What the agent reads back: what the frame does not prove, and what to open.
 * @param {readonly string[]} knownEntries
 */
export function entryCheckRefusal(knownEntries) {
  const where = knownEntries.length > 0
    ? `a page this project already knows: ${knownEntries.join("; ")}`
    : "the product's application area — an /app, /dashboard or workspace path, or the user menu / open-app control on the landing page — not the sign-in page";
  return "ShipBash did not accept this conclusion yet. A saved sign-in was applied to this browser, and the only pages seen so far "
    + "are the product root and the sign-in surface; a sign-in form standing over a valid session proves nothing (many products keep it up). "
    + `Open the signed-in entry once and judge from that page: ${where}. `
    + "If that page also denies access, make this same call again — it will be accepted.";
}

/** The one line the owner sees when the refusal happens. */
export const ENTRY_CHECK_OWNER_NOTE =
  "ShipBash asked the agent to check the signed-in entry before concluding: a saved sign-in was applied, "
  + "and the agent had only seen the product root and the sign-in page. The run is a little longer for it.";

/**
 * The gate at an acceptance point. `pagesSeen` returns the pages this leg has
 * landed on, or null when the record is unavailable.
 * @param {{
 *   signInLoaded: boolean,
 *   productionUrl: string,
 *   pagesSeen: () => Promise<string[] | null> | string[] | null,
 *   knownEntries?: () => Promise<string[]> | string[],
 * }} leg
 */
export function createEntryCheck({ signInLoaded, productionUrl, pagesSeen, knownEntries = () => [] }) {
  let refusals = 0;
  return {
    /** The refusal for the agent, or null when the conclusion stands. */
    async review() {
      if (refusals > 0 || !signInLoaded) return null;
      const pages = await pagesSeen();
      if (pages === null || !onlyDoorstepSeen(pages, productionUrl)) return null;
      refusals += 1;
      return entryCheckRefusal(await knownEntries());
    },
    refusals: () => refusals,
  };
}

/**
 * The case lane's file channel (case-entry-check.mjs ↔ progress-session.mjs):
 * the progress tools already know the attempt's work directory — its
 * checklist event file lives there — so the three files sit beside it at
 * fixed names, and nothing else has to name them. `arming` (the production
 * URL) is written by the runner only for an attempt that loaded a sign-in
 * state; `pages` is the pages the sidecar reported; `refused` is the tools'
 * marker back.
 */
export const ENTRY_CHECK_FILES = Object.freeze({
  arming: "entry-check.json",
  pages: "pages-seen.json",
  refused: "entry-check-refused",
});

/**
 * The case lane's page record: the pages the sidecar reported, written as a
 * file — origin + path only, the whole list rewritten on each new page.
 * @param {string} path
 * @param {(path: string, content: string, options?: object) => Promise<unknown>} write
 */
export function createPagesSeenRecord(path, write) {
  const seen = new Set();
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  return {
    /** @param {string} url */
    record(url) {
      const page = pageOf(url);
      if (!page || seen.has(page)) return;
      seen.add(page);
      const content = `${JSON.stringify([...seen])}\n`;
      chain = chain.then(() => write(path, content, { mode: 0o600 })).catch(() => undefined);
    },
    settled: () => chain,
  };
}

/**
 * The record as the progress tools read it: the list, or null when there
 * is no readable record.
 * @param {string} path
 * @param {(path: string, encoding: string) => Promise<unknown>} read
 * @returns {Promise<string[] | null>}
 */
export async function readPagesSeen(path, read) {
  try {
    const parsed = JSON.parse(String(await read(path, "utf8")));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : null;
  } catch {
    return null;
  }
}

/**
 * The arming file's content — the production URL — or null when the attempt
 * was never armed (no sign-in state loaded, or another lane's tools).
 * @param {string} path
 * @param {(path: string, encoding: string) => Promise<unknown>} read
 * @returns {Promise<{ productionUrl: string } | null>}
 */
export async function readEntryCheckArming(path, read) {
  try {
    const parsed = JSON.parse(String(await read(path, "utf8")));
    return typeof parsed?.productionUrl === "string" ? { productionUrl: parsed.productionUrl } : null;
  } catch {
    return null;
  }
}

/**
 * The progress tools' half of the case lane's gate: armed lazily from the
 * files beside the event file, so tools that were never armed refuse nothing.
 * @param {string} directory
 * @param {(path: string, encoding: string) => Promise<unknown>} read
 * @param {(...segments: string[]) => string} join
 */
export function createFileArmedEntryCheck(directory, read, join) {
  /** @type {ReturnType<typeof createEntryCheck> | null} */
  let check = null;
  return {
    async review() {
      if (!check) {
        const armed = await readEntryCheckArming(join(directory, ENTRY_CHECK_FILES.arming), read);
        if (!armed) return null;
        check = createEntryCheck({
          signInLoaded: true,
          productionUrl: armed.productionUrl,
          pagesSeen: () => readPagesSeen(join(directory, ENTRY_CHECK_FILES.pages), read),
        });
      }
      return check.review();
    },
    refusedPath: join(directory, ENTRY_CHECK_FILES.refused),
  };
}
