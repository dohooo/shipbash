/**
 * record_knowledge, executed on the host for the job's own agent: each entry
 * the runner's own validation accepts (knowledge-record.mjs) is stored under
 * the job's lease (store/knowledge.ts insertKnowledgeEntryForJob), which is
 * the authority on its shape, and the agent reads back the short id each
 * entry got, or why the record refused it. A case's agent records this way,
 * through the job API's agentTool; an Activity's entries still ride its
 * progress channel.
 */
import type postgres from "postgres";

import { runRecordKnowledge } from "@shipbash/runner/runtime/knowledge-record.mjs";

import { parseKnowledgeEntry } from "../knowledge.ts";
import { shortKnowledgeId } from "../knowledge-context.ts";
import { recordJobKnowledgeEntry } from "../store/job-store-activity.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import type { AgentDataAnswer } from "./index.ts";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One entry as the record keeps it: its short id, or why it was refused. */
async function storeEntry(sql: postgres.Sql, capability: DispatchJobLeaseCapability, event: Record<string, unknown>) {
  try {
    const entry = parseKnowledgeEntry({ kind: event.kind, entryTitle: event.title, body: event.body });
    const record = await recordJobKnowledgeEntry(sql, capability, {
      entry,
      supersedes: typeof event.supersedes === "string" ? event.supersedes : null,
    });
    return { id: shortKnowledgeId(record.id) };
  } catch (error) {
    return { rejected: message(error) };
  }
}

export async function recordKnowledge(sql: postgres.Sql, capability: DispatchJobLeaseCapability, args: Record<string, unknown>): Promise<AgentDataAnswer> {
  try {
    return { text: await runRecordKnowledge(args, { appendEvent: (event) => storeEntry(sql, capability, event), nextRevision: () => 0 }) };
  } catch (error) {
    return { error: message(error) };
  }
}
