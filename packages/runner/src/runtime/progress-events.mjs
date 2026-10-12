// The envelope every progress tool appends its event in: one JSON line
// opening with schemaVersion, written utf8 with mode 0600. The event brings
// its revision, its name and its fields, in the order they are written.
export function appendProgressEvent(append, path, event) {
  return append(path, `${JSON.stringify({ schemaVersion: 1, ...event })}\n`, { encoding: "utf8", mode: 0o600 });
}
