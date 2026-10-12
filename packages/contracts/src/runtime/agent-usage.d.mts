/** One model response's token counters, as every agent_usage record names them. */
export type AgentUsageCounts = Partial<Record<"input" | "cacheRead" | "cacheWrite" | "output" | "total", number>>;

/** The counters `usage` holds (pi's response usage, or a record's), safe non-negative integers only. */
export declare function agentUsageCounts(usage: unknown): AgentUsageCounts;
