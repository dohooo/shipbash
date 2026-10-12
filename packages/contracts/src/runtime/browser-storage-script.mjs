// The page-side half of the ShipBash browser state: what a document holds in
// localStorage, sessionStorage and IndexedDB, read inside the page and
// serialized so it can be put back into a fresh profile, and the restore
// that puts IndexedDB back (cookies and the two key-value storages go back
// through agent-browser's `state load`; IndexedDB has no CDP write command,
// so it is written by a page script as Playwright's storageScript.ts does).
//
// Every function below is embedded in the page by source
// (Function.prototype.toString) and runs there as a plain script, so each
// uses only web globals and the other functions of this file: no imports,
// no module-level constants. Node can run the same functions with
// fakes standing in for the globals.
//
// Values are kept as they are when JSON can hold them (a plain object, an
// array, a string, a finite number, a boolean, null); anything else is
// encoded as a tagged envelope — a Date, a typed array, a Blob, a Map — and
// what cannot be carried at all is recorded as `unsupported` rather than
// thrown, so one odd value never costs the rest of the capture.

/** A plain object of any realm: its prototype is an Object.prototype or null. */
function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** True when JSON carries the value unchanged: no Date, no bytes, no NaN, no undefined. */
function isTrivialValue(value, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.every((entry) => isTrivialValue(entry, depth + 1));
  if (isPlainRecord(value)) return Object.values(value).every((entry) => isTrivialValue(entry, depth + 1));
  return false;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The envelope for an ArrayBuffer, a typed array, a DataView, a Blob or a File; null for anything else. */
async function encodeBinaryValue(value, kind) {
  if (kind === "ArrayBuffer") return { $t: "bytes", kind, base64: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return { $t: "bytes", kind, base64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (kind !== "Blob" && kind !== "File") return null;
  const base64 = bytesToBase64(new Uint8Array(await value.arrayBuffer()));
  return kind === "File"
    ? { $t: "blob", kind, type: value.type, base64, name: value.name, lastModified: value.lastModified }
    : { $t: "blob", kind, type: value.type, base64 };
}

/** The envelope for a Map, a Set, an array or a plain object; null for anything else. */
async function encodeCollection(value, kind, seen) {
  if (kind !== "Map" && kind !== "Set" && !Array.isArray(value) && !isPlainRecord(value)) return null;
  // The path down, not everything seen: a leaf reached twice is written
  // twice, and only a container that contains itself is a cycle.
  seen.add(value);
  try {
    return await encodeCollectionEntries(value, kind, seen);
  } finally {
    seen.delete(value);
  }
}

async function encodeCollectionEntries(value, kind, seen) {
  if (kind === "Map") {
    const entries = [];
    for (const [key, entry] of value) entries.push([await encodeStoredValue(key, seen), await encodeStoredValue(entry, seen)]);
    return { $t: "map", entries };
  }
  if (kind === "Set") {
    const values = [];
    for (const entry of value) values.push(await encodeStoredValue(entry, seen));
    return { $t: "set", values };
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const entry of value) items.push(await encodeStoredValue(entry, seen));
    return { $t: "array", items };
  }
  const props = [];
  for (const [key, entry] of Object.entries(value)) props.push([key, await encodeStoredValue(entry, seen)]);
  return { $t: "object", props };
}

/**
 * The tagged envelope for any value structured clone accepts. A container
 * that contains itself is recorded as unsupported where the cycle closes:
 * the envelope is a tree.
 */
async function encodeStoredValue(value, seen = new WeakSet()) {
  if (isTrivialValue(value)) return { $t: "json", v: value };
  if (value === undefined) return { $t: "undefined" };
  if (typeof value === "number") return { $t: "number", v: String(value) };
  if (typeof value === "bigint") return { $t: "bigint", v: value.toString() };
  if (typeof value !== "object") return { $t: "unsupported", kind: typeof value };
  if (seen.has(value)) return { $t: "unsupported", kind: "cycle" };
  const kind = Object.prototype.toString.call(value).slice(8, -1);
  if (kind === "Date") return { $t: "date", v: String(value.getTime()) };
  if (kind === "RegExp") return { $t: "regexp", source: value.source, flags: value.flags };
  const encoded = (await encodeBinaryValue(value, kind)) ?? (await encodeCollection(value, kind, seen));
  return encoded ?? { $t: "unsupported", kind };
}

function decodeBytes(encoded) {
  const bytes = base64ToBytes(encoded.base64);
  if (encoded.kind === "ArrayBuffer") return bytes.buffer;
  if (encoded.kind === "DataView") return new DataView(bytes.buffer);
  const TypedArray = globalThis[encoded.kind];
  return typeof TypedArray === "function" ? new TypedArray(bytes.buffer) : bytes;
}

/** The value an envelope stands for; undefined for what was recorded as unsupported. */
function decodeStoredValue(encoded) {
  if (!isPlainRecord(encoded) || typeof encoded.$t !== "string") return undefined;
  switch (encoded.$t) {
    case "json": return encoded.v;
    case "number": return Number(encoded.v);
    case "bigint": return BigInt(encoded.v);
    case "date": return new Date(Number(encoded.v));
    case "regexp": return new RegExp(encoded.source, encoded.flags);
    case "bytes": return decodeBytes(encoded);
    case "blob": {
      const bytes = base64ToBytes(encoded.base64);
      return encoded.kind === "File"
        ? new File([bytes], encoded.name, { type: encoded.type, lastModified: encoded.lastModified })
        : new Blob([bytes], { type: encoded.type });
    }
    case "map": return new Map(encoded.entries.map(([key, value]) => [decodeStoredValue(key), decodeStoredValue(value)]));
    case "set": return new Set(encoded.values.map((value) => decodeStoredValue(value)));
    case "array": return encoded.items.map((item) => decodeStoredValue(item));
    case "object": return Object.fromEntries(encoded.props.map(([key, value]) => [key, decodeStoredValue(value)]));
    default: return undefined;
  }
}

/**
 * A request as a promise. A delete or a version change another connection
 * holds open fires `blocked` and then waits for that connection to close,
 * which on a page of ShipBash's own never happens; it is failed at once.
 */
function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed.")));
    request.addEventListener("blocked", () => reject(new Error("blocked by an open connection")));
  });
}

function withDeadline(promise, deadline, label) {
  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** Every entry of a Storage, in the page's own order; a storage the page may not read yields none. */
function storageEntries(storage) {
  const entries = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (typeof name === "string") entries.push({ name, value: String(storage.getItem(name)) });
    }
  } catch {
    // A sandboxed document throws on access; it holds nothing to keep.
  }
  return entries;
}

/**
 * One store's records, read one value at a time so no more than the byte
 * limit is ever held: the keys come in one transaction, each value in a
 * transaction of its own — encoding a Blob leaves the task, and a
 * transaction with nothing pending by then has already committed — and
 * `bytes` runs across the database, so reading stops the moment the limit
 * is passed instead of after everything was fetched.
 */
async function collectStore(db, storeName, budget, bytes) {
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  const keys = await idbRequest(store.getAllKeys());
  if (keys.length > budget.maxRecords) {
    throw new Error(`store ${storeName} holds ${String(keys.length)} records, over the ${String(budget.maxRecords)} limit`);
  }
  const indexes = Array.from(store.indexNames).map((indexName) => {
    const index = store.index(indexName);
    return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
  });
  const records = [];
  for (const key of keys) {
    const value = await idbRequest(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
    const record = isTrivialValue(key) ? { key } : { keyEncoded: await encodeStoredValue(key) };
    if (isTrivialValue(value)) record.value = value;
    else record.valueEncoded = await encodeStoredValue(value);
    bytes.used += JSON.stringify(record).length;
    if (bytes.used > budget.maxBytes) throw new Error(`over the ${String(budget.maxBytes)} byte limit`);
    records.push(record);
  }
  return { name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, records };
}

async function readDatabase(indexedDB, name, budget) {
  const db = await idbRequest(indexedDB.open(name));
  try {
    const bytes = { used: 0 };
    const stores = [];
    for (const storeName of Array.from(db.objectStoreNames)) stores.push(await collectStore(db, storeName, budget, bytes));
    return { name, version: db.version, stores };
  } finally {
    db.close();
  }
}

/**
 * One database, or its name with why it could not be read: the whole read
 * — opening, the values, their encoding — took longer than the page's
 * budget, it holds more than the record limit, it passes the byte limit,
 * or IndexedDB refused it.
 */
async function collectDatabase(indexedDB, info, budget) {
  const name = typeof info.name === "string" ? info.name : "";
  const version = typeof info.version === "number" ? info.version : 0;
  try {
    if (name.length === 0) throw new Error("unnamed database");
    return await withDeadline(readDatabase(indexedDB, name, budget), budget.deadline, `reading ${name}`);
  } catch (error) {
    return { name, version, stores: [], unsupported: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Every database of the origin, read side by side against one deadline;
 * none when they cannot be listed in time, and any still unread when the
 * deadline passes recorded by name as timed out.
 */
async function collectIndexedDb(indexedDB, budget) {
  if (!indexedDB || typeof indexedDB.databases !== "function") return [];
  let infos;
  try {
    infos = await withDeadline(indexedDB.databases(), budget.deadline, "listing databases");
  } catch {
    return [];
  }
  const collected = infos.map(() => null);
  await withDeadline(
    Promise.all(infos.map((info, index) => collectDatabase(indexedDB, info, budget).then((database) => {
      collected[index] = database;
    }))),
    budget.deadline + 250,
    "reading databases",
  ).catch(() => {});
  return infos.map((info, index) => collected[index] ?? {
    name: typeof info.name === "string" ? info.name : "",
    version: typeof info.version === "number" ? info.version : 0,
    stores: [],
    unsupported: "reading timed out.",
  });
}

/**
 * The origin's storage as the ShipBash state carries it. The key-value
 * storages are read first and always handed out; IndexedDB gets the budget,
 * and what it could not read in time is recorded as unsupported.
 *
 * @param {{ location: { origin: string }, localStorage: Storage, sessionStorage: Storage, indexedDB: IDBFactory | undefined }} globals
 * @param {{ timeoutMs: number, maxRecords: number, maxBytes: number }} options
 */
async function collectBrowserStorage(globals, options) {
  const budget = { deadline: Date.now() + options.timeoutMs, maxRecords: options.maxRecords, maxBytes: options.maxBytes };
  const origin = globals.location.origin;
  const localStorage = storageEntries(globals.localStorage);
  const sessionStorage = storageEntries(globals.sessionStorage);
  const indexedDB = await withDeadline(collectIndexedDb(globals.indexedDB, budget), budget.deadline + 500, "reading IndexedDB")
    .catch(() => []);
  return { origin, localStorage, sessionStorage, indexedDB };
}

function recordValue(record) {
  return "value" in record ? record.value : decodeStoredValue(record.valueEncoded);
}

/** Rebuilds one database at its version — every store and index — then adds every record. */
async function restoreDatabase(indexedDB, database) {
  const request = indexedDB.open(database.name, database.version);
  request.addEventListener("upgradeneeded", () => {
    const db = request.result;
    for (const store of database.stores) {
      const objectStore = db.createObjectStore(store.name, { keyPath: store.keyPath ?? null, autoIncrement: store.autoIncrement === true });
      for (const index of store.indexes) {
        objectStore.createIndex(index.name, index.keyPath, { unique: index.unique === true, multiEntry: index.multiEntry === true });
      }
    }
  });
  const db = await idbRequest(request);
  try {
    const stores = database.stores.filter((store) => store.records.length > 0);
    if (stores.length === 0) return;
    const transaction = db.transaction(stores.map((store) => store.name), "readwrite");
    for (const store of stores) {
      const objectStore = transaction.objectStore(store.name);
      // A store with a key path derives each key from its value and refuses
      // an explicit one; a store without one needs the key handed back.
      const inlineKeys = store.keyPath !== null && store.keyPath !== undefined;
      await Promise.all(store.records.map((record) => idbRequest(inlineKeys
        ? objectStore.add(recordValue(record))
        : objectStore.add(recordValue(record), "key" in record ? record.key : decodeStoredValue(record.keyEncoded)))));
    }
  } finally {
    db.close();
  }
}

/**
 * Puts the captured databases back on this origin. Each one is deleted
 * first: `state load` navigated the real origin a moment ago, and a page
 * that creates its database on load (Firebase does) left an empty one
 * behind. A database that will not go back is named in `failed`, and the
 * rest still go.
 *
 * @returns {Promise<{ restored: string[], failed: string[] }>}
 */
async function restoreIndexedDb(indexedDB, databases) {
  const outcome = { restored: [], failed: [] };
  for (const database of databases) {
    if (typeof database.unsupported === "string") continue;
    try {
      await idbRequest(indexedDB.deleteDatabase(database.name));
      await restoreDatabase(indexedDB, database);
      outcome.restored.push(database.name);
    } catch (error) {
      outcome.failed.push(`${database.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}

// Node side: the functions above by source, for the page.
const PAGE_FUNCTIONS = [
  isPlainRecord, isTrivialValue, bytesToBase64, base64ToBytes, encodeBinaryValue, encodeCollection, encodeCollectionEntries,
  encodeStoredValue,
  decodeBytes, decodeStoredValue, idbRequest, withDeadline, storageEntries, collectStore, readDatabase,
  collectDatabase, collectIndexedDb, collectBrowserStorage, recordValue, restoreDatabase, restoreIndexedDb,
];
const PAGE_SCRIPT_PRELUDE = PAGE_FUNCTIONS.map((fn) => fn.toString()).join("\n");

/** What one page may spend on its storage: wall-clock, records per store, bytes per database. */
export const BROWSER_STORAGE_BUDGET = Object.freeze({ timeoutMs: 5_000, maxRecords: 2_000, maxBytes: 1_048_576 });

/**
 * A Runtime.evaluate expression (awaitPromise) whose value is the JSON of
 * the page's storage — `{origin, localStorage, sessionStorage, indexedDB}` —
 * with `extraFields`, an object-literal fragment such as `href: location.href`,
 * spread beside it.
 */
export function browserStoragePageExpression(extraFields = "", options = {}) {
  const budget = { ...BROWSER_STORAGE_BUDGET, ...options };
  const fields = extraFields.trim().length > 0 ? `, ${extraFields}` : "";
  return `(async () => {\n${PAGE_SCRIPT_PRELUDE}\n`
    + `const storage = await collectBrowserStorage(globalThis, ${JSON.stringify(budget)});\n`
    + `return JSON.stringify({ ...storage${fields} });\n})()`;
}

/** A Runtime.evaluate expression (awaitPromise) whose value is the JSON `{restored, failed}` of putting these databases back. */
export function indexedDbRestoreExpression(databases) {
  return `(async () => {\n${PAGE_SCRIPT_PRELUDE}\n`
    + `return JSON.stringify(await restoreIndexedDb(globalThis.indexedDB, ${JSON.stringify(databases)}));\n})()`;
}

export { collectBrowserStorage, decodeStoredValue, encodeStoredValue, isTrivialValue, restoreIndexedDb };
