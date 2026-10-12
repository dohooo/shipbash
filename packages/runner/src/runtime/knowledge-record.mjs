// The knowledge recorder: the agent's write side of the Project's memory.
//
// One call carries every entry a page earned. Bookkeeping that costs a whole
// model round per fact is bookkeeping worth batching: a 32-minute Discovery
// spent 35 of its 211 rounds on a single-entry record_knowledge each, and a
// round is seconds of latency plus the whole context read again. So `entries`
// is the tool's only shape. Each entry is validated exactly as one call used
// to be; the valid ones are written and the refused ones come back named by
// their index, so the next call carries only what failed instead of the whole
// page again. A call that records nothing throws, which is what a single bad
// entry did before and what puts a tool_error on the run's journal.
import { IDENTIFIER_PATTERN, isRecord as record, requiredString as text } from "@shipbash/contracts/runtime/contract-values.mjs";
import { AGENT_KNOWLEDGE_KINDS, describeKnowledgeBodyFields, validateKnowledgeBody } from "@shipbash/contracts/runtime/knowledge-contract.mjs";

// A page's worth of facts, not a run's: a batch past this is the agent
// dumping its whole memory rather than recording what it just saw.
const MAX_ENTRIES = 20;

// supersedes links a prior entry by its id; the host reader requires an
// identifier, so a free-text value — a description of the entry rather than
// its id, which the agent sometimes gives — is dropped here instead of being
// written for the reader to reject and crash the run on.
function normalizeSupersedes(value) {
  if (value == null) return null;
  const normalized = text(value, "supersedes", 64);
  return IDENTIFIER_PATTERN.test(normalized) ? normalized : null;
}

export function recordToolDefinition() {
  return {
    name: "record_knowledge",
    description:
      "Record durable facts about this product so the next run starts where this one ended: a page you understood, "
      + "a route you walked, a decision you made alone, or how to operate the test environment. Record every entry "
      + "you have for the page you are on in ONE call — entries is a list, and a second call for the same page is a "
      + "wasted turn. Record them all as you go: a fact left unrecorded is one the next run has to rediscover. "
      + "When you observe something that contradicts an entry you were given, write the new entry and set "
      + "supersedes to that entry's id. This reporting tool cannot control the browser. Body fields by kind — "
      + describeKnowledgeBodyFields()
      + ". Unlisted fields are rejected; list fields take string arrays.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        entries: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ENTRIES,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: [...AGENT_KNOWLEDGE_KINDS] },
              title: { type: "string", minLength: 1, maxLength: 120 },
              body: { type: "object" },
              supersedes: { type: "string", minLength: 1, maxLength: 64 },
            },
            required: ["kind", "title", "body"],
          },
        },
      },
      required: ["entries"],
    },
  };
}

/** One entry in the shape the journal takes it, or a throw naming what is wrong. */
function parseEntry(value) {
  if (!record(value)) throw new Error("an entry must be an object.");
  const kind = text(value.kind, "kind", 32);
  const title = text(value.title, "title", 120);
  // Structural only, and the check of the kind itself (qa is not the
  // agent's to write); src/knowledge.ts on the host is the authority and
  // reports anything it rejects back as an agent_warning.
  const body = validateKnowledgeBody(kind, value.body);
  return { kind, title, body, supersedes: normalizeSupersedes(value.supersedes) };
}

/**
 * Writes one batch and returns the per-entry report the agent reads back.
 * The journal envelope stays with the other Discovery events: this takes the
 * writer, not the path. A writer that stores the entry itself (the host's,
 * agent-data/record.ts) answers `{ id }`, the short id the report names, or
 * `{ rejected }`, why it refused the entry, which the report names in its
 * place; a writer that only journals it answers nothing.
 * @param {Record<string, unknown>} args
 * @param {{ appendEvent: (event: Record<string, unknown>) => unknown, nextRevision: () => number }} io
 */
export async function runRecordKnowledge(args, { appendEvent, nextRevision }) {
  const entries = args.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("entries must be a non-empty array of knowledge entries.");
  }
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`entries takes at most ${String(MAX_ENTRIES)} entries in one call.`);
  }
  const report = [];
  let recorded = 0;
  for (const [index, value] of entries.entries()) {
    let entry;
    try {
      entry = parseEntry(value);
    } catch (error) {
      report.push(`entries[${String(index)}] rejected: ${error instanceof Error ? error.message : "invalid entry."}`);
      continue;
    }
    const written = await appendEvent({ revision: nextRevision(), event: "knowledge_entry", ...entry });
    if (typeof written?.rejected === "string") {
      report.push(`entries[${String(index)}] rejected: ${written.rejected}`);
      continue;
    }
    recorded += 1;
    report.push(typeof written?.id === "string" ? `Recorded ${entry.kind} ${written.id}: ${entry.title}` : `Recorded ${entry.kind}: ${entry.title}`);
  }
  // Nothing written is a failed call, exactly as one bad entry always was:
  // the journal gets a tool_error and the agent reads an error, not a result.
  if (recorded === 0) throw new Error(report.join(" "));
  return report.join("\n");
}
