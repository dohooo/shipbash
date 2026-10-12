// The knowledge recall tool: the agent's read side of the Project's memory,
// in every lane that runs an agent on the product.
//
// The record answers it (control-plane agent-data/): every knowledge entry on
// record when the run started, one line each, packed as the run's opening
// was — what the opening had to cut first, the testing context too when it
// did not fit whole (control-plane knowledge-opening.ts) — and rendered here.
// The opening carries only what fits its one budget (contracts
// opening-context.mjs) and a RESUMED session none at all, so this is where
// the rest is read. The filter is a case-insensitive substring over
// title+line: the corpus is line-shaped, so anything beyond that is machinery
// nobody needs.
import { KNOWLEDGE_KINDS } from "@shipbash/contracts/runtime/knowledge-contract.mjs";
import { TESTING_CONTEXT_KIND } from "@shipbash/contracts/runtime/opening-context.mjs";

const RECALL_RESULT_LIMIT = 50;

const RECALL_HEADINGS = {
  [TESTING_CONTEXT_KIND]: "The testing context",
  environment: "How to operate this environment",
  qa: "What the user has already decided",
  decision: "Choices ShipBash made on its own",
  path: "Routes already walked",
  page: "Pages already understood",
};

export function recallToolDefinition() {
  return {
    name: "recall_knowledge",
    // The corpus is what was on record when the run started, so what is
    // recorded while it runs waits for the next. The description is the same
    // in every lane, so it names only what every lane has: when to call it is
    // each lane's prompt rule.
    description:
      "Look up what ShipBash already knows about this product: how to operate the test environment, the owner's "
      + "answers, and the pages, routes, and decisions earlier runs recorded — whatever your opening context left "
      + "out comes first, the testing context too when it was cut. Returns the matches grouped by kind, one "
      + `"- [id] line" each, at most ${String(RECALL_RESULT_LIMIT)} per call with a count of the rest. It holds what `
      + "was on record when you started; entries recorded since then are not in it.",
    inputSchema: {
      type: "object",
      properties: {
        kinds: { type: "array", items: { type: "string", enum: [TESTING_CONTEXT_KIND, ...KNOWLEDGE_KINDS] }, description: "Limit to these kinds." },
        query: { type: "string", description: "Case-insensitive substring over titles and content." },
      },
      additionalProperties: false,
    },
  };
}

/**
 * One recall over the corpus as the record packed it: the filters, then
 * per-kind sections in the line shape the opening context used, in the order
 * the corpus holds them — what the opening cut comes first.
 * @param {Record<string, unknown>} args
 * @param {ReadonlyArray<{ id: string, kind: string, title: string, line: string }>} entries
 */
export function recallKnowledgeText(args, entries) {
  const kinds = Array.isArray(args.kinds) && args.kinds.length > 0
    ? new Set(args.kinds.map((kind) => String(kind)))
    : null;
  const query = typeof args.query === "string" && args.query.trim()
    ? args.query.trim().toLowerCase()
    : null;
  const matched = entries.filter((entry) =>
    (!kinds || kinds.has(entry.kind))
    && (!query || `${entry.title ?? ""}\n${entry.line}`.toLowerCase().includes(query)));
  if (matched.length === 0) return "No recorded knowledge matches that filter.";
  const shown = matched.slice(0, RECALL_RESULT_LIMIT);
  const sections = [];
  for (const kind of new Set(shown.map((entry) => entry.kind))) {
    if (!Object.hasOwn(RECALL_HEADINGS, kind)) continue;
    sections.push(`${RECALL_HEADINGS[kind]}:`);
    for (const entry of shown.filter((item) => item.kind === kind)) sections.push(`- [${entry.id}] ${entry.line}`);
  }
  if (matched.length > shown.length) {
    sections.push(`(${String(matched.length - shown.length)} more — narrow with kinds or query.)`);
  }
  return sections.join("\n");
}
