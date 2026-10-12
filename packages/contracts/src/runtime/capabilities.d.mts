export interface Bindings {
  repository: boolean;
  /** At least one saved sign-in is on offer. */
  signIns: boolean;
  /** The leg records its screen for the owner: an Activity whose input says recordScreen. */
  recording: boolean;
}

export type CapabilityRow = "knowledge" | "record" | "journeys" | "edits" | "github" | "browser" | "terminal" | "credentials" | "delegate" | "video";
export type ScenarioKind = "conversation" | "initial_discovery" | "walk" | "generate_cases" | "case";

export interface Capability {
  readonly tools: readonly string[];
  readonly runs: "host" | "sandbox";
  /** The binding the row is on only with. */
  readonly needs?: keyof Bindings;
  /** How to use the row, appended to the system prompt of a session that holds it. */
  readonly fragment?: string;
}

export interface Scenario {
  readonly runs: "host" | "sandbox";
  readonly own: readonly string[];
  readonly off: readonly CapabilityRow[];
}

export interface Resolved {
  rows: string[];
  tools: string[];
}

export interface CapabilityTable {
  capabilities: Readonly<Record<string, Capability>>;
  scenarios: Readonly<Record<string, Scenario>>;
}

export declare const CAPABILITIES: Readonly<Record<CapabilityRow, Capability>>;
export declare const SCENARIOS: Readonly<Record<ScenarioKind, Scenario>>;
export declare function assertTable(table: { capabilities: Readonly<Record<string, unknown>>; scenarios: Readonly<Record<string, { readonly off: readonly string[] }>> }): void;
export declare function resolve(kind: string, bindings: Bindings, table?: CapabilityTable): Resolved;
export declare function holds(kind: string, row: CapabilityRow): boolean;
export declare function scenariosHolding(row: CapabilityRow): string[];
export declare function capabilityFragments(rows: readonly string[]): string[];
