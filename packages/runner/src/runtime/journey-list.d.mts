export declare const JOURNEY_LIST_STATUSES: readonly ["approved", "draft", "all"];
export declare const JOURNEY_LIST_DETAILS: readonly ["summary", "full"];
export type JourneyListStatus = (typeof JOURNEY_LIST_STATUSES)[number];
export type JourneyListDetail = (typeof JOURNEY_LIST_DETAILS)[number];
/** The most walks, a review no walk left counted as one, whose drafts one answer lists; the rest are counted. */
export declare const DRAFT_WALKS_LIMIT: number;
/** `1 Journey`, `3 hooks`; `plural` where adding an s does not make it. */
export declare function counted(count: number, noun: string, plural?: string): string;
/** Where these groups of drafts came from: the walks that left them, and the reviews no walk left. */
export declare function draftSources(groups: ReadonlyArray<{ walk?: unknown }>): { walks: number; reviews: number; total: number };
/** `3 walks and 1 review`, `2 walks`, `1 review`: the sources as a count names them. */
export declare function sourcesText(sources: { walks: number; reviews: number }): string;

/** list_journeys as every agent that holds it reads it: a name, what the model reads, and a JSON Schema for its input. */
export declare function listJourneysDefinition(): {
  name: "list_journeys";
  description: string;
  inputSchema: {
    type: "object";
    additionalProperties: false;
    properties: {
      status: { type: "string"; enum: JourneyListStatus[]; description: string };
      detail: { type: "string"; enum: JourneyListDetail[]; description: string };
    };
  };
};
/** What a list_journeys call asks, checked; a malformed call throws the sentence the agent reads. */
export declare function journeyListArgs(args: Record<string, unknown>): { status: JourneyListStatus; detail: JourneyListDetail };
/** list_journeys in a Sandbox session: the record's answer, with the session's own list merged in when it holds add_journey. */
export declare function runListJourneys(
  args: Record<string, unknown>,
  io: {
    keepsList: boolean;
    storePath: string;
    readControlFile(path: string, encoding: "utf8"): Promise<string>;
    agentData(name: string, args: Record<string, unknown>): Promise<string>;
  },
): Promise<string>;
