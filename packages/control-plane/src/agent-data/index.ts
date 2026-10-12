/**
 * The agent's tools the record answers on demand, under one scope rule: the
 * job's lease names the team, the Project, the Activity or Suite Run and the
 * moment the leg was claimed (store/history-for-job.ts agentDataScope), never
 * the caller. One function serves the chat turn in-process, the local lane's
 * broker and the job API's `agentTool`; which kinds hold each read is the
 * capability table's, and none is checked here. The writes act under the
 * lease: record_knowledge stores (record.ts), and a case's agent records
 * through it; propose_edit stages a change to an approved Journey or hook as
 * the Activity's creator (edit.ts). The arguments are checked against each
 * tool's own schema first:
 * an unknown key, a limit past 20 or an id of no record's format is the
 * tool's own error, never an HTTP one.
 */
import type postgres from "postgres";
import { z } from "zod";

import type { AgentDataTool, AgentWriteTool } from "@shipbash/contracts/runtime/agent-data-contract.mjs";
import { TESTING_CONTEXT_KIND } from "@shipbash/contracts/runtime/opening-context.mjs";
import { HISTORY_SCOPES } from "@shipbash/runner/runtime/history-tools.mjs";
import { JOURNEY_LIST_DETAILS, JOURNEY_LIST_STATUSES } from "@shipbash/runner/runtime/journey-list.mjs";
import { recallKnowledgeText } from "@shipbash/runner/runtime/knowledge-recall.mjs";

import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { ConsoleLinks } from "../console-links.ts";
import { KNOWLEDGE_KINDS } from "../knowledge.ts";
import { packRunKnowledge } from "../knowledge-opening.ts";
import { loadDispatchTarget } from "../store/dispatch-target.ts";
import { agentDataScope } from "../store/history-for-job.ts";
import { listKnowledgeEntries } from "../store/knowledge.ts";
import type { DispatchJobLeaseCapability } from "../types.ts";
import { proposeEdit } from "./edit.ts";
import { type HistoryReader, listHistory, readHistory } from "./history.ts";
import { listJourneys } from "./journeys.ts";
import { recordKnowledge } from "./record.ts";

export interface AgentDataToolCall {
  name: AgentDataTool | AgentWriteTool;
  args: Record<string, unknown>;
  /** The case agent's Journey, or null for an Activity's agent. */
  caseId: string | null;
}

/** The tool's text, or its own error: never an HTTP error. */
export type AgentDataAnswer = { text: string } | { error: string };

type ArtifactReads = Pick<SupabaseArtifactStorage, "downloadObject"> | null;

/** A record's id as list_history prints it: its kind's letter, then six hex digits. */
const recordId = z.string().trim().regex(/^[a-z][0-9a-f]{6}$/u, "must be an id list_history printed");

const recallArgs = z.strictObject({
  kinds: z.array(z.enum([TESTING_CONTEXT_KIND, ...KNOWLEDGE_KINDS])).optional(),
  query: z.string().optional(),
});

const listArgs = z.strictObject({
  scope: z.enum(HISTORY_SCOPES),
  journey: z.string().optional(),
  limit: z.int().min(1).max(20).optional(),
  before: recordId.optional(),
});

const journeysArgs = z.strictObject({
  status: z.enum(JOURNEY_LIST_STATUSES).default("all"),
  detail: z.enum(JOURNEY_LIST_DETAILS).default("summary"),
});

const readArgs = z.strictObject({
  id: recordId,
  find: z.string().max(200).optional(),
  offset: z.int().min(1).optional(),
});

function refused(error: z.ZodError): AgentDataAnswer {
  const issue = error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return { error: `The arguments are invalid${where}: ${issue?.message ?? "unknown reason"}` };
}

/**
 * Runs one read tool for the job `capability` holds. `links` are the chat's
 * console pages, which its runs and walks show in place of their run ids.
 */
export async function runAgentDataTool(
  sql: postgres.Sql,
  storage: ArtifactReads,
  capability: DispatchJobLeaseCapability,
  call: AgentDataToolCall,
  links: ConsoleLinks | null = null,
): Promise<AgentDataAnswer> {
  if (call.name === "record_knowledge") return recordKnowledge(sql, capability, call.args);
  if (call.name === "propose_edit") return proposeEdit(sql, capability, call.args, links);
  if (call.name === "recall_knowledge") {
    const args = recallArgs.safeParse(call.args);
    if (!args.success) return refused(args.error);
    const scope = await agentDataScope(sql, capability);
    const [{ testingContext }, entries] = await Promise.all([
      loadDispatchTarget(sql, capability),
      listKnowledgeEntries(sql, { teamId: scope.teamId, projectId: scope.projectId, asOf: scope.asOf }),
    ]);
    return { text: recallKnowledgeText(args.data, packRunKnowledge(testingContext, entries).corpus) };
  }
  if (call.name === "list_journeys") {
    const args = journeysArgs.safeParse(call.args);
    if (!args.success) return refused(args.error);
    return { text: await listJourneys({ sql, scope: await agentDataScope(sql, capability), links }, args.data) };
  }
  const reader = async (): Promise<HistoryReader> =>
    ({ sql, storage, scope: await agentDataScope(sql, capability), caseId: call.caseId, links });
  if (call.name === "list_history") {
    const args = listArgs.safeParse(call.args);
    return args.success ? { text: await listHistory(await reader(), args.data) } : refused(args.error);
  }
  const args = readArgs.safeParse(call.args);
  return args.success ? { text: await readHistory(await reader(), args.data) } : refused(args.error);
}
