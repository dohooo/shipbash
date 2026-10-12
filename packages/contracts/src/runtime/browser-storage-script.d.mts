import type { BrowserOrigin, EncodedStoredValue, IndexedDbDatabase } from "./browser-state.d.mts";

export interface BrowserStorageBudget {
  /** Wall-clock the page may spend on all of its IndexedDB databases together. */
  timeoutMs: number;
  /** A store with more records than this is recorded as unsupported. */
  maxRecords: number;
  /** A database whose JSON is larger than this is recorded as unsupported. */
  maxBytes: number;
}
/** The globals the collection reads; the page passes globalThis, Node can pass fakes. */
export interface BrowserStorageGlobals {
  location: { origin: string };
  localStorage: Pick<Storage, "length" | "key" | "getItem">;
  sessionStorage: Pick<Storage, "length" | "key" | "getItem">;
  indexedDB: unknown;
}
export interface IndexedDbRestoreOutcome {
  restored: string[];
  failed: string[];
}
export declare const BROWSER_STORAGE_BUDGET: Readonly<BrowserStorageBudget>;
export declare function isTrivialValue(value: unknown): boolean;
export declare function encodeStoredValue(value: unknown): Promise<EncodedStoredValue>;
export declare function decodeStoredValue(encoded: unknown): unknown;
export declare function collectBrowserStorage(
  globals: BrowserStorageGlobals,
  options: BrowserStorageBudget,
): Promise<BrowserOrigin>;
export declare function restoreIndexedDb(indexedDB: unknown, databases: IndexedDbDatabase[]): Promise<IndexedDbRestoreOutcome>;
export declare function browserStoragePageExpression(extraFields?: string, options?: Partial<BrowserStorageBudget>): string;
export declare function indexedDbRestoreExpression(databases: IndexedDbDatabase[]): string;
