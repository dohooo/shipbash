// The ShipBash browser state: the one document a sign-in is kept in, whether
// the takeover viewer captured it over CDP or the Activity's own browser
// did at the end of a leg. Cookies keep every field Chromium reports
// (partitionKey and the real sameSite included; none is invented), and each
// origin keeps its localStorage, sessionStorage and IndexedDB.
//
// The document keeps agent-browser's state-file shape (cookies, then origins
// with localStorage and sessionStorage) and adds IndexedDB; the runner puts
// all of it back over CDP (runner/src/runtime/browser-state-restore.mjs). A
// document written before sessionStorage and IndexedDB were captured reads as
// one whose origins hold neither.
//
// Dependencies: the contract-values.mjs leaf only. This is reachable from the
// console's workflow bundle.
import { isRecord } from "./contract-values.mjs";

const SAME_SITE = new Set(["Strict", "Lax", "None"]);

function normalizeCookie(cookie) {
  if (
    !isRecord(cookie)
    || typeof cookie.name !== "string"
    || typeof cookie.value !== "string"
    || typeof cookie.domain !== "string"
    || typeof cookie.path !== "string"
  ) return null;
  const partitionKey = isRecord(cookie.partitionKey) && typeof cookie.partitionKey.topLevelSite === "string"
    ? { topLevelSite: cookie.partitionKey.topLevelSite, hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor === true }
    : null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: typeof cookie.expires === "number" && Number.isFinite(cookie.expires) ? cookie.expires : -1,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    ...(typeof cookie.sameSite === "string" && SAME_SITE.has(cookie.sameSite) ? { sameSite: cookie.sameSite } : {}),
    ...(partitionKey ? { partitionKey } : {}),
  };
}

function storageEntries(value) {
  return Array.isArray(value)
    ? value.flatMap((entry) =>
        (isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string"
          ? [{ name: entry.name, value: entry.value }]
          : []))
    : [];
}

function keyPathOf(value) {
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : null;
}

function normalizeIndex(index) {
  const keyPath = isRecord(index) ? keyPathOf(index.keyPath) : null;
  if (!isRecord(index) || typeof index.name !== "string" || keyPath === null) return null;
  return { name: index.name, keyPath, unique: index.unique === true, multiEntry: index.multiEntry === true };
}

/** A record keeps what it carried: a key or its envelope, a value or its envelope; without a value it is nothing. */
function normalizeRecord(record) {
  if (!isRecord(record) || !("value" in record || "valueEncoded" in record)) return null;
  const kept = {};
  for (const field of ["key", "keyEncoded", "value", "valueEncoded"]) {
    if (field in record) kept[field] = record[field];
  }
  return kept;
}

function normalizeStore(store) {
  if (!isRecord(store) || typeof store.name !== "string") return null;
  return {
    name: store.name,
    keyPath: keyPathOf(store.keyPath),
    autoIncrement: store.autoIncrement === true,
    indexes: Array.isArray(store.indexes) ? store.indexes.flatMap((index) => normalizeIndex(index) ?? []) : [],
    records: Array.isArray(store.records) ? store.records.flatMap((record) => normalizeRecord(record) ?? []) : [],
  };
}

function normalizeDatabase(database) {
  if (!isRecord(database) || typeof database.name !== "string") return null;
  return {
    name: database.name,
    version: typeof database.version === "number" && Number.isInteger(database.version) && database.version > 0 ? database.version : 1,
    stores: Array.isArray(database.stores) ? database.stores.flatMap((store) => normalizeStore(store) ?? []) : [],
    ...(typeof database.unsupported === "string" ? { unsupported: database.unsupported } : {}),
  };
}

/** The origin's storage in the state's shape, or null when it names no origin or holds nothing worth carrying. */
function normalizeOrigin(origin) {
  if (!isRecord(origin) || typeof origin.origin !== "string") return null;
  const normalized = {
    origin: origin.origin,
    localStorage: storageEntries(origin.localStorage),
    sessionStorage: storageEntries(origin.sessionStorage),
    indexedDB: Array.isArray(origin.indexedDB) ? origin.indexedDB.flatMap((database) => normalizeDatabase(database) ?? []) : [],
  };
  return originHoldsStorage(normalized) ? normalized : null;
}

/** How many IndexedDB records the origin holds; a database that exists with empty stores holds none. */
function indexedDbRecordCount(origin) {
  return Array.isArray(origin.indexedDB)
    ? origin.indexedDB.reduce((count, database) =>
        count + (Array.isArray(database.stores)
          ? database.stores.reduce((inner, store) => inner + (Array.isArray(store.records) ? store.records.length : 0), 0)
          : 0), 0)
    : 0;
}

/**
 * Whether the origin stores anything: an entry in either key-value storage
 * or a record in IndexedDB. A database with empty stores is what a page
 * creates on load before anyone signs in (Firebase's
 * firebaseLocalStorageDb), and is not evidence of a sign-in.
 */
export function originHoldsStorage(origin) {
  if (!isRecord(origin)) return false;
  return storageEntries(origin.localStorage).length > 0
    || storageEntries(origin.sessionStorage).length > 0
    || indexedDbRecordCount(origin) > 0;
}

/** Which kinds of storage the origin holds something in, in a fixed order. */
export function originStorageKinds(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];
  return [
    ...(normalized.localStorage.length > 0 ? ["localStorage"] : []),
    ...(normalized.sessionStorage.length > 0 ? ["sessionStorage"] : []),
    ...(indexedDbRecordCount(normalized) > 0 ? ["indexedDB"] : []),
  ];
}

function recordKeyLabel(record) {
  if ("key" in record) return typeof record.key === "string" ? record.key : JSON.stringify(record.key);
  const encoded = record.keyEncoded;
  const label = isRecord(encoded) && encoded.$t === "date" ? `date:${String(encoded.v)}` : JSON.stringify(encoded ?? null);
  return String(label).slice(0, 120);
}

/**
 * One label per stored entry, names only, never a value: `storage <name>`
 * for localStorage, `session <name>` for sessionStorage, and
 * `indexeddb <database>/<store>/<key>` for each IndexedDB record — the
 * entries the sign-in ruler counts and diffs against its baseline.
 *
 * @returns {string[]}
 */
export function storageEntryLabels(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return [];
  return [
    ...normalized.localStorage.map((entry) => `storage ${entry.name}`),
    ...normalized.sessionStorage.map((entry) => `session ${entry.name}`),
    ...normalized.indexedDB.flatMap((database) =>
      database.stores.flatMap((store) =>
        store.records.map((record) => `indexeddb ${database.name}/${store.name}/${recordKeyLabel(record)}`))),
  ];
}

/**
 * Any state document — captured by either lane, or written before
 * sessionStorage and IndexedDB were captured — read into the canonical
 * shape. Malformed cookies and origins are dropped; an origin that holds
 * nothing is not kept.
 */
export function normalizeBrowserState(value) {
  const cookies = isRecord(value) && Array.isArray(value.cookies) ? value.cookies : [];
  const origins = isRecord(value) && Array.isArray(value.origins) ? value.origins : [];
  return {
    cookies: cookies.flatMap((cookie) => normalizeCookie(cookie) ?? []),
    origins: origins.flatMap((origin) => normalizeOrigin(origin) ?? []),
  };
}
