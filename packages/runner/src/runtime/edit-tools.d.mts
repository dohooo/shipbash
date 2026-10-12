import type { EditsAtVersion } from "@shipbash/contracts/runtime/agent-data-contract.mjs";

/** An edit tool as the runner defines it, its input's properties by name. */
export interface EditToolDefinition<Property extends string> {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: Record<Property, Record<string, unknown>>;
    required: Property[];
  };
}

export declare function proposeEditDefinition(): EditToolDefinition<
  "caseId" | "title" | "category" | "steps" | "checkpoints" | "whyItMatters" | "instruction"
>;
export declare function verifyEditsDefinition(): EditToolDefinition<"edits" | "title">;
export declare function decideEditsDefinition(): EditToolDefinition<"decision" | "walk" | "edits">;

/** The approved Case a propose_edit call names. */
export declare function proposedCaseId(args: Record<string, unknown>): string;

/** The content propose_edit stages, checked as an entry of the Case's role, and the instruction for the walk that proves it. */
export interface ProposedEdit {
  content: {
    title: string;
    category: string;
    steps: string[];
    checkpoints: Array<{ goal: string; afterStep: number | null }>;
    whyItMatters: string | null;
  };
  instruction: string;
}

export declare function proposedEdit(
  args: Record<string, unknown>,
  current: { role: string; title: string; category: string; whyItMatters: string | null },
): ProposedEdit;

export declare function unquotedTextNote(instructions: readonly string[], jev: { url: string; apiKey: string }): Promise<string>;

export declare function verifyEditsInput(args: Record<string, unknown>): { edits: EditsAtVersion; title: string };
export declare function decideEditsInput(args: Record<string, unknown>):
  | { decision: "keep"; walk: string }
  | { decision: "discard"; edits: EditsAtVersion };
