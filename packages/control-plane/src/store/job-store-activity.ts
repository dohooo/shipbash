import type postgres from "postgres";

import type { ProductKnowledgeRecord } from "../knowledge.ts";
import type { ActivityStatus, DispatchJobLeaseCapability } from "../types.ts";
import { reportToParentConversation } from "./conversation-reports.ts";
import { lockDispatchJobCapability, requireActivityId } from "./dispatch-capabilities.ts";
import { appendActivityEventForJob } from "./job-events.ts";
import type { AppendActivityEventForJobInput, KnowledgeEntryForJobInput } from "./job-store-inputs.ts";
import {
	insertKnowledgeEntryForJob,
	transitionActivityStatusForJob,
} from "./knowledge.ts";

export async function recordJobKnowledgeEntry(
	sql: postgres.Sql,
	capability: DispatchJobLeaseCapability,
	input: KnowledgeEntryForJobInput,
): Promise<ProductKnowledgeRecord> {
	return sql.begin(async (transaction) =>
		insertKnowledgeEntryForJob(
			transaction,
			await lockDispatchJobCapability(transaction, capability),
			input,
		),
	);
}

export async function transitionJobActivityInput(
	sql: postgres.Sql,
	capability: DispatchJobLeaseCapability,
	from: ActivityStatus,
	to: ActivityStatus,
	refusal?: string,
): Promise<void> {
	await sql.begin(async (transaction) => {
		const job = await lockDispatchJobCapability(transaction, capability);
		await transitionActivityStatusForJob(transaction, job, from, to, refusal);
	});
}

/**
 * The leg asks its owner a question: the Activity waits for the answer, the
 * question goes on record, and a walk a conversation started reports it to
 * that conversation, which wakes to ask the owner (conversation-reports.ts).
 * One write, so the report's turn always finds the question it reports.
 */
export async function markJobActivityWaitingForInput(
	sql: postgres.Sql,
	capability: DispatchJobLeaseCapability,
	question: AppendActivityEventForJobInput,
): Promise<void> {
	await sql.begin(async (transaction) => {
		const job = await lockDispatchJobCapability(transaction, capability);
		await transitionActivityStatusForJob(transaction, job, "running", "waiting_for_input");
		await appendActivityEventForJob(transaction, capability, question);
		await reportToParentConversation(transaction, { walkActivityId: requireActivityId(job) });
	});
}
