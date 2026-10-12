export interface SignInPageVerdict {
  /** The product page's origin and path at capture; query and hash are not kept. */
  url: string;
  /** True while that page still showed a sign-in surface. */
  signInSurface: boolean;
  /** What made it one: password_field, oauth:N, identity:path, … */
  signals: string[];
}
export type SignInScopeReason = "accepted" | "no_product_page" | "sign_in_surface" | "no_product_storage";
import type { StorageKind } from "./browser-state.d.mts";

export interface SignInScope {
  /** The product origin the state was read against, or "" when unparseable. */
  productOrigin: string;
  /** The product's registrable domain: app., api., www. and the apex are one site. */
  productSite: string;
  /** The verdict: a product page past its sign-in surface, with something of the product's to save. */
  product: boolean;
  reason: SignInScopeReason;
  /** The container's reading of the product page, or null when none was open. */
  page: SignInPageVerdict | null;
  /** Cookies on the product's site, httpOnly or not. */
  productCookies: number;
  /** Stored origins on the product's site that hold something. */
  productOrigins: number;
  /** Which kinds of storage the product's origins hold something in. */
  productStorage: StorageKind[];
  /** Foreign hosts the browser is signed into, first-seen order, cookies before origins. */
  elsewhere: string[];
  /** What signInBaselineDiff found, or null when there was no baseline to diff against. */
  newSignInEntries: string[] | null;
  /** The hosts of the pages the capture asked and got no usable answer from in time. */
  unanswered: string[];
  /**
   * no_new_sign_in_entries: accepted, but the diff against the anonymous baseline found nothing.
   * pages_unanswered: a page did not answer in time; its storage went unread.
   * indexeddb_unsupported:<database>: <reason>: a database on the product's site could not be read.
   */
  warnings: string[];
  cookies: number;
  origins: number;
}
export declare function hostOf(value: unknown): string;
export declare function publicPageUrl(href: string): string;
export declare function registrableDomain(host: unknown): string;
export declare function readSignInScope(
  state: unknown,
  productionOrigin: unknown,
  page?: unknown,
  newSignInEntries?: string[] | null,
  unanswered?: unknown,
): SignInScope;
export declare function signInBaselineDiff(before: unknown, after: unknown, productionOrigin: unknown): string[];
export declare function productStateEntryCount(
  state: unknown,
  productionOrigin: unknown,
): { cookies: number; origins: number };
export declare function signInStateRegression(
  before: unknown,
  after: unknown,
  productionOrigin: unknown,
): string | null;
export declare function signInRefusalMessage(scope: SignInScope, productHost: string): string;
export declare const UNCAPTURABLE_SIGN_IN: string;
