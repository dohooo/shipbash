/** recall_knowledge as every lane defines it: what the model reads, and the JSON Schema of its input. */
export declare function recallToolDefinition(): {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: {
      kinds: { type: string; items: { type: string; enum: string[] }; description: string };
      query: { type: string; description: string };
    };
    additionalProperties: boolean;
  };
};

/** One recall's answer over the corpus the record packed (control-plane agent-data/). */
export declare function recallKnowledgeText(
  args: Record<string, unknown>,
  entries: ReadonlyArray<{ id: string; kind: string; title: string; line: string }>,
): string;
