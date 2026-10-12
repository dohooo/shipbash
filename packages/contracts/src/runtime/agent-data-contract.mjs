// The agent's tools that the record answers on demand (control-plane
// agent-data/): the reads, which the server answers for any kind without
// checking it (which kinds hold each is the capability table's), and the
// writes: the entry a case's agent records, the edit an agent stages.
export const AGENT_DATA_TOOLS = Object.freeze(["recall_knowledge", "list_history", "read_history", "list_journeys"]);
// A write: the job API sends a call to it again only when it provably never
// left (job-api.mjs), so an entry is never stored twice.
export const AGENT_WRITE_TOOLS = Object.freeze(["record_knowledge", "propose_edit"]);
// What the record answers wherever the agent runs — through the job API in a
// Sandbox, in-process in the chat: the reads and the staged edit. The chat
// carries record_knowledge on its event channel instead (control-plane
// conversation-turn/tools.ts).
export const RECORD_ANSWERED_TOOLS = Object.freeze([...AGENT_DATA_TOOLS, "propose_edit"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Whether a value is a record's id as the store keeps it: an Activity's, a proposal's. */
export function isRecordUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

// The token propose_edit answers, and verify_edits and a discard carry back:
// the staging draft's id and the moment it last changed, so the owner's yes
// binds to the version they saw (control-plane store/edits-for-job.ts).
const EDITS_MESSAGE = "edits must be the token propose_edit answered, as it gave it.";

/** @param {{ id: string, updatedAt: string }} draft */
export function editsToken(draft) {
  return `${draft.id}@${draft.updatedAt}`;
}

/** The staged edits a token names, at the version it names; a value that is no such token throws. */
export function editsAtVersion(value) {
  const [id = "", version = "", ...rest] = typeof value === "string" ? value.split("@") : [];
  if (!isRecordUuid(id) || !version || rest.length > 0) throw new Error(EDITS_MESSAGE);
  return { id, version };
}
