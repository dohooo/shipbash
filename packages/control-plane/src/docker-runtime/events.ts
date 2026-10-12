import { StringDecoder } from "node:string_decoder";

import { isRecord } from "../is-record.ts";
import { redactRuntimeValue } from "./redaction.ts";

export interface DockerRuntimeEvent {
  type: string;
  channel?: "suite" | "case" | "agent" | "browser" | "infrastructure";
  [key: string]: unknown;
}

function isRuntimeEvent(value: unknown): value is DockerRuntimeEvent {
  return isRecord(value) && typeof value.type === "string";
}

const MAX_NDJSON_LINE_LENGTH = 1_000_000;

export class NdjsonEventParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly sensitiveValues: readonly string[];
  private buffered = "";

  constructor(sensitiveValues: readonly string[] = []) {
    this.sensitiveValues = sensitiveValues.filter(Boolean);
  }

  push(chunk: Buffer | string): DockerRuntimeEvent[] {
    this.buffered += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.buffered.length > MAX_NDJSON_LINE_LENGTH && !this.buffered.includes("\n")) {
      throw new Error("Runtime emitted an NDJSON line larger than 1 MB.");
    }

    const lines = this.buffered.split(/\r?\n/);
    this.buffered = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  finish(): DockerRuntimeEvent[] {
    this.buffered += this.decoder.end();
    const line = this.buffered;
    this.buffered = "";
    return this.parseLine(line);
  }

  private parseLine(line: string): DockerRuntimeEvent[] {
    if (!line.trim()) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Runtime stdout contained invalid NDJSON.");
    }
    const event = redactRuntimeValue(parsed, "", this.sensitiveValues);
    if (!isRuntimeEvent(event)) {
      throw new Error("Runtime NDJSON events must be objects with a string type.");
    }
    return [event];
  }
}
