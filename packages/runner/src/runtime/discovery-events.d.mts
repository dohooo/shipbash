// The host-side types for discovery-events.mjs: a conversation's host turn
// carries a recorded knowledge entry through it (control-plane
// conversation-turn/tools.ts), as a Sandbox leg's progress channel does.
import type { ACTIVITY_EVENT_KINDS } from "@shipbash/contracts/runtime/event-contract.mjs";

/** A parsed Discovery event: its name, and the fields its parser checked. */
export type DiscoveryEvent = { event: string } & Record<string, unknown>;

/** How one Discovery event surfaces to the host: the Activity event it becomes. */
export interface DiscoveryEventEmission {
  kind: (typeof ACTIVITY_EVENT_KINDS)[number];
  label: string;
  payload: { bodyMarkdown?: string; safeData: Record<string, string | number | boolean | null> };
}

export declare function parseDiscoveryProgressEvent(
  event: string,
  value: Record<string, unknown>,
  redactString: (text: string, limit: number) => string,
): DiscoveryEvent | null;

export declare function discoveryEventEmission(update: DiscoveryEvent): DiscoveryEventEmission | null;
