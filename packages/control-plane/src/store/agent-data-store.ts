/**
 * The agent data facet: the agent's read tools and the openings a leg or a
 * run starts on (agent-data/). Every read takes its scope — team, Project,
 * Activity or Suite Run, and the moment the job was claimed — from the
 * job's lease (history-for-job.ts agentDataScope), never from its caller,
 * so the pool it reads over stays private to this facet.
 */
import type postgres from "postgres";

import { type AgentDataAnswer, type AgentDataToolCall, runAgentDataTool } from "../agent-data/index.ts";
import { type ActivityLegOpening, activityLegOpening, type SuiteRunOpening, suiteRunOpening } from "../agent-data/opening.ts";
import type { SupabaseArtifactStorage } from "../artifact-storage.ts";
import type { ConsoleLinks } from "../console-links.ts";
import type { ActivityExecutionInput, DispatchJobLeaseCapability, SuiteExecutionInput } from "../types.ts";
import type { StoreConnection } from "./connection.ts";
import type { InternalStore } from "./internal-store.ts";

type ArtifactReads = Pick<SupabaseArtifactStorage, "downloadObject"> | null;

export class AgentDataStore {
	private readonly sql: postgres.Sql;
	private readonly internal: InternalStore;

	constructor(connection: StoreConnection, internal: InternalStore) {
		this.sql = connection.sql;
		this.internal = internal;
	}

	/** One read tool for the job `capability` holds; `links` are the chat's console pages. */
	runTool(capability: DispatchJobLeaseCapability, call: AgentDataToolCall, storage: ArtifactReads, links: ConsoleLinks | null = null): Promise<AgentDataAnswer> {
		return runAgentDataTool(this.sql, storage, capability, call, links);
	}

	/** An Activity leg's opening, as the record stood when its job was claimed. */
	activityOpening(capability: DispatchJobLeaseCapability, execution: ActivityExecutionInput, links: ConsoleLinks | null = null): Promise<ActivityLegOpening> {
		return activityLegOpening({ sql: this.sql, internal: this.internal }, { capability, execution }, links);
	}

	/** A Suite Run's opening, as the record stood when its job was claimed. */
	suiteOpening(capability: DispatchJobLeaseCapability, execution: SuiteExecutionInput, storage: ArtifactReads): Promise<SuiteRunOpening> {
		return suiteRunOpening({ sql: this.sql, internal: this.internal }, storage, { capability, execution });
	}
}
