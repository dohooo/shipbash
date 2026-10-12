import {
  identifier,
  isRecord,
  positiveInteger,
  rejectUnknownKeys,
  requiredString,
} from "@shipbash/contracts/runtime/contract-values.mjs";
import { safeDataFieldLimit } from "@shipbash/contracts/runtime/activity-safe-data.mjs";
import { ACTIVITY_EVENT_KINDS as ACTIVITY_EVENT_KIND_LIST } from "@shipbash/contracts/runtime/event-contract.mjs";
import { StringDecoder } from "node:string_decoder";

import { SENSITIVE_KEY_PATTERN, redactString } from "./redaction.ts";

export interface ActivityRuntimeEvent {
  type: "activity_event";
  schemaVersion: 1;
  activityId: string;
  sequence: number;
  timestamp: string;
  kind: (typeof ACTIVITY_EVENT_KIND_LIST)[number];
  label: string;
  bodyMarkdown: string | null;
  safeData: Record<string, string | number | boolean | null>;
}

const MAX_EVENT_LINE = 256 * 1024;
const ACTIVITY_EVENT_KINDS = new Set<string>(ACTIVITY_EVENT_KIND_LIST);

function isActivityEventKind(value: string): value is ActivityRuntimeEvent["kind"] {
  return ACTIVITY_EVENT_KINDS.has(value);
}

export class ActivityNdjsonParser {
  readonly #decoder = new StringDecoder("utf8");
  readonly #sensitiveValues: readonly string[];
  #buffer = "";

  constructor(sensitiveValues: readonly string[] = []) {
    this.#sensitiveValues = sensitiveValues.filter(Boolean);
  }

  push(chunk: Buffer | string): ActivityRuntimeEvent[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    if (this.#buffer.length > MAX_EVENT_LINE && !this.#buffer.includes("\n")) {
      throw new Error("Activity runtime emitted an oversized NDJSON event.");
    }
    const lines = this.#buffer.split(/\r?\n/u);
    this.#buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.#parse(line));
  }

  finish(): ActivityRuntimeEvent[] {
    this.#buffer += this.#decoder.end();
    const line = this.#buffer;
    this.#buffer = "";
    return this.#parse(line);
  }

  #parse(line: string): ActivityRuntimeEvent[] {
    if (!line.trim()) return [];
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE) {
      throw new Error("Activity runtime emitted an oversized NDJSON event.");
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Activity runtime stdout contained invalid NDJSON.");
    }
    if (!isRecord(value)) throw new Error("Activity runtime event must be an object.");
    if (value.type !== "activity_event" || value.schemaVersion !== 1) {
      throw new Error("Activity runtime event has an unsupported schema.");
    }
    rejectUnknownKeys(
      value,
      new Set(["type", "schemaVersion", "activityId", "sequence", "timestamp", "kind", "label", "bodyMarkdown", "safeData"]),
      "event",
    );
    const kind = requiredString(value.kind, "event.kind", 32);
    if (!isActivityEventKind(kind)) throw new Error("Activity runtime event kind is unsupported.");
    const safeData = this.#buildSafeData(value.safeData);
    const timestamp = requiredString(value.timestamp, "event.timestamp", 64);
    if (Number.isNaN(new Date(timestamp).valueOf())) throw new Error("Activity runtime event timestamp is invalid.");
    return [{
      type: "activity_event",
      schemaVersion: 1,
      activityId: identifier(value.activityId, "event.activityId"),
      sequence: positiveInteger(value.sequence, "event.sequence"),
      timestamp,
      kind,
      label: redactString(requiredString(value.label, "event.label", 160), this.#sensitiveValues),
      bodyMarkdown: value.bodyMarkdown === null
        ? null
        : redactString(requiredString(value.bodyMarkdown, "event.bodyMarkdown", 20_000), this.#sensitiveValues),
      safeData,
    }];
  }

  // Not boundedSafeData (packages/contracts/src/runtime/activity-safe-data.mjs): the trust gate
  // THROWS on oversized records and non-primitive values where the reader
  // hops slice and drop.
  #buildSafeData(raw: unknown): Record<string, string | number | boolean | null> {
    if (!isRecord(raw) || Object.keys(raw).length > 20) {
      throw new Error("Activity runtime safeData must be a bounded object.");
    }
    const safeData: Record<string, string | number | boolean | null> = {};
    for (const [key, entry] of Object.entries(raw)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) continue;
      if (entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        safeData[key] = typeof entry === "string"
          ? redactString(entry, this.#sensitiveValues, safeDataFieldLimit(key))
          : entry;
      } else {
        throw new Error("Activity runtime safeData may contain only primitive values.");
      }
    }
    return safeData;
  }
}
