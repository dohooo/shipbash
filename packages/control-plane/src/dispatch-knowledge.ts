/**
 * Landing a Runner's knowledge entry on the host.
 *
 * The Runner validates bodies structurally so the agent gets an immediate
 * error, but src/knowledge.ts is the authority and gets the last word here.
 * A body it rejects costs that one entry and nothing else: killing a
 * twenty-minute exploration over a malformed note would be a far worse
 * failure than losing the note.
 */
import { parseStructuredField } from "@shipbash/contracts/runtime/activity-safe-data.mjs";
import type { DispatchJobLeaseCapability } from "./types.ts";

// src/knowledge.ts is the authority on an entry's shape, and the store runs
// it. This lane only forwards, so it names the entry `unknown` rather than
// claim a shape it has not checked; JobStore still satisfies the method.
interface KnowledgeWriter {
  recordKnowledgeEntryForJob(
    capability: DispatchJobLeaseCapability,
    input: { entry: unknown; supersedes?: string | null },
  ): Promise<unknown>;
}

/** Returns a warning message when the entry was rejected, null when stored. */
export async function recordRunnerKnowledge(
  store: KnowledgeWriter,
  capability: DispatchJobLeaseCapability,
  safeData: Record<string, unknown>,
): Promise<string | null> {
  const body = parseStructuredField(safeData.bodyJson);
  if (!body) return "Knowledge entry body did not survive the run's event channel.";
  try {
    await store.recordKnowledgeEntryForJob(capability, {
      entry: {
        kind: safeData.kind,
        entryTitle: safeData.title,
        body,
      },
      supersedes: typeof safeData.supersedes === "string" ? safeData.supersedes : null,
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Knowledge entry could not be stored.";
  }
}
