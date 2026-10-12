import type { ActivityKind } from "@shipbash/contracts/database-contract-types";
import { PUBLIC_ACTIVITIES_KIND_VALUES } from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";

/**
 * The Activity page's two layouts, and the cookie that remembers the reader's
 * choice for each kind of Activity. A cookie rather than browser storage: the
 * server draws the page for the request, so it reads the choice with the
 * request and the page's first frame is already the layout the browser keeps.
 * This module owns the cookie's format: the server reads it from the request,
 * the browser from the document, both through `storedActivityLayouts`.
 */
export type ActivityLayout = "stage" | "split";

/** The reader's choice for each Activity kind they have switched. */
export type StoredActivityLayouts = Partial<Record<ActivityKind, ActivityLayout>>;

const COOKIE_PREFIX = "shipbash.activity-layout.";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function layoutNamed(value: string): ActivityLayout | null {
  return value === "stage" || value === "split" ? value : null;
}

function kindNamed(suffix: string): ActivityKind | null {
  return PUBLIC_ACTIVITIES_KIND_VALUES.find((kind) => kind === suffix) ?? null;
}

/** The stored choices among `cookies`: a cookie for a kind that does not exist stores nothing. */
export function storedActivityLayouts(cookies: readonly { name: string; value: string }[]): StoredActivityLayouts {
  const stored: StoredActivityLayouts = {};
  for (const { name, value } of cookies) {
    if (!name.startsWith(COOKIE_PREFIX)) continue;
    const kind = kindNamed(name.slice(COOKIE_PREFIX.length));
    const layout = layoutNamed(value);
    if (kind && layout) stored[kind] = layout;
  }
  return stored;
}

/** The stored choices this document's cookies hold. Browser only. */
export function documentActivityLayouts(): StoredActivityLayouts {
  return storedActivityLayouts(document.cookie.split("; ").map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1) };
  }));
}

/** Stores the reader's choice for `kind`. Browser only. */
export function writeActivityLayout(kind: ActivityKind, layout: ActivityLayout): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing from Safari before 18.4, which Next still supports; this write is synchronous and the server reads it with the next request.
  document.cookie = `${COOKIE_PREFIX}${kind}=${layout}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
