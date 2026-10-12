export interface StorageEntry {
  name: string;
  value: string;
}
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch, or -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  /** Only when Chromium reported one; never invented. */
  sameSite?: "Strict" | "Lax" | "None";
  /** A partitioned (CHIPS) cookie's partition, as Chromium reports it. */
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}
/** A value JSON cannot carry unchanged, tagged by what it was. */
export type EncodedStoredValue =
  | { $t: "json"; v: unknown }
  | { $t: "undefined" }
  | { $t: "number"; v: string }
  | { $t: "bigint"; v: string }
  | { $t: "date"; v: string }
  | { $t: "regexp"; source: string; flags: string }
  | { $t: "bytes"; kind: string; base64: string }
  | { $t: "blob"; kind: "Blob" | "File"; type: string; base64: string; name?: string; lastModified?: number }
  | { $t: "map"; entries: [EncodedStoredValue, EncodedStoredValue][] }
  | { $t: "set"; values: EncodedStoredValue[] }
  | { $t: "array"; items: EncodedStoredValue[] }
  | { $t: "object"; props: [string, EncodedStoredValue][] }
  | { $t: "unsupported"; kind: string };
/** One IndexedDB record: the key and the value, each as JSON when JSON can hold it and as an envelope otherwise. */
export interface IndexedDbRecord {
  key?: unknown;
  keyEncoded?: EncodedStoredValue;
  value?: unknown;
  valueEncoded?: EncodedStoredValue;
}
export interface IndexedDbIndex {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}
export interface IndexedDbStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexedDbIndex[];
  records: IndexedDbRecord[];
}
export interface IndexedDbDatabase {
  name: string;
  version: number;
  stores: IndexedDbStore[];
  /** Why the database could not be read (a timeout, a limit, a refusal); its stores are then empty. */
  unsupported?: string;
}
export interface BrowserOrigin {
  origin: string;
  localStorage: StorageEntry[];
  sessionStorage: StorageEntry[];
  indexedDB: IndexedDbDatabase[];
}
export interface BrowserState {
  cookies: BrowserCookie[];
  origins: BrowserOrigin[];
}
export type StorageKind = "localStorage" | "sessionStorage" | "indexedDB";
export declare function originHoldsStorage(origin: unknown): boolean;
export declare function originStorageKinds(origin: unknown): StorageKind[];
export declare function storageEntryLabels(origin: unknown): string[];
export declare function normalizeBrowserState(value: unknown): BrowserState;
