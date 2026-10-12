/**
 * The key a page's knowledge is filed under. The host derives the page_key
 * column from it (control-plane src/knowledge.ts) and the Runner's browser
 * proxy looks page notes up by it (runner runtime/harness-notes.mjs), so both
 * read this one function. Two URLs that show the same page to different data
 * must produce the same key, or the browser proxy would never surface a note
 * twice.
 *
 * Protocol, query, and fragment are dropped; the host is lowercased; the
 * trailing slash goes; identifier-shaped path segments become `:id`.
 * Returns null when the value is not a usable URL.
 */

// A path segment carrying no meaning of its own: a uuid, an opaque hex handle,
// or a numeric row id. Collapsing these is what makes /orders/1 and /orders/2
// the same page as far as knowledge is concerned.
const OPAQUE_SEGMENT = /^(?:[0-9a-f]{8,}|\d+)$/iu;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function normalizePageKey(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    try {
      url = new URL(`https://${raw}`);
    } catch {
      return null;
    }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.host.toLowerCase();
  if (!host) return null;
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (UUID_SEGMENT.test(segment) || OPAQUE_SEGMENT.test(segment) ? ":id" : segment));
  return segments.length > 0 ? `${host}/${segments.join("/")}` : host;
}
