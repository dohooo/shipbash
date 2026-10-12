/** The record_knowledge tool's definition: its name, description and input schema. */
export declare function recordToolDefinition(): {
  name: "record_knowledge";
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: {
      entries: {
        type: "array";
        minItems: number;
        maxItems: number;
        items: {
          type: "object";
          additionalProperties: false;
          properties: {
            kind: { type: "string"; enum: string[] };
            title: { type: "string"; minLength: number; maxLength: number };
            body: { type: "object" };
            supersedes: { type: "string"; minLength: number; maxLength: number };
          };
          required: string[];
        };
      };
    };
    required: string[];
  };
};

/**
 * Validates and writes one batch, answering the per-entry report. The writer
 * may answer `{ id }` (the report names it) or `{ rejected }` (the entry is
 * reported refused for that reason); a call that records nothing throws.
 */
export declare function runRecordKnowledge(
  args: Record<string, unknown>,
  io: {
    appendEvent: (event: Record<string, unknown>) => unknown;
    nextRevision: () => number;
  },
): Promise<string>;
