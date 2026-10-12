export declare const AGENT_DATA_TOOLS: readonly ["recall_knowledge", "list_history", "read_history", "list_journeys"];
export type AgentDataTool = (typeof AGENT_DATA_TOOLS)[number];
export declare const AGENT_WRITE_TOOLS: readonly ["record_knowledge", "propose_edit"];
export type AgentWriteTool = (typeof AGENT_WRITE_TOOLS)[number];
export declare const RECORD_ANSWERED_TOOLS: readonly [...typeof AGENT_DATA_TOOLS, "propose_edit"];
export type RecordAnsweredTool = (typeof RECORD_ANSWERED_TOOLS)[number];

export declare function isRecordUuid(value: unknown): value is string;

/** The staged edits a token names, at the version it names. */
export interface EditsAtVersion {
  id: string;
  version: string;
}

export declare function editsToken(draft: { id: string; updatedAt: string }): string;
export declare function editsAtVersion(value: unknown): EditsAtVersion;
