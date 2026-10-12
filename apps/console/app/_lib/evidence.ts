import type { RunCaseView } from "@shipbash/contracts/api/view-types";
import { CASE_REPLAY_FILE } from "@shipbash/contracts/runtime/browser-recording-format.mjs";
import { isRecord } from "../../lib/is-record";

type RunArtifact = Pick<RunCaseView["detail"]["artifacts"][number], "id" | "label" | "url">;

/**
 * The evidence recorder names each frame `evidence-step-<seq>-<tool>.jpg` and
 * writes the page's console to `evidence-console.jsonl`. Reading those names
 * back is how a walk's files become a strip of screenshots and a console fold
 * without a second round trip for the manifest.
 */
const STEP_LABEL = /^evidence-step-(\d+)-(.+)\.(?:jpg|jpeg|png)$/u;
/** What the recorder names the page console; the report gives it its own heading. */
export const CONSOLE_LABEL = "evidence-console.jsonl";

export interface EvidenceStep {
  id: string;
  url: string;
  sequence: number;
  /** The action, not its plumbing: "mcp__agent_browser__agent_browser_click" → "click". */
  action: string;
}

/**
 * The recorder writes the MCP tool id verbatim. Only its last segment says what
 * the agent did, so the caption keeps that and drops the transport prefix.
 */
function actionName(tool: string): string {
  const leaf = tool.split("__").at(-1) ?? tool;
  return leaf.replace(/^(?:agent_)?browser_/u, "").replaceAll("_", " ") || leaf;
}

export function evidenceSteps(artifacts: readonly RunArtifact[]): EvidenceStep[] {
  return artifacts
    .flatMap((artifact) => {
      const match = STEP_LABEL.exec(artifact.label);
      if (!match) return [];
      return [{
        id: artifact.id,
        url: artifact.url,
        sequence: Number(match[1]),
        // biome-ignore lint/style/noNonNullAssertion: the label pattern has two capture groups, so a match always carries both.
        action: actionName(match[2]!),
      }];
    })
    .sort((left, right) => left.sequence - right.sequence);
}

export function evidenceConsoleUrl(artifacts: readonly RunArtifact[]): string | null {
  return artifacts.find((artifact) => artifact.label === CONSOLE_LABEL)?.url ?? null;
}

/** The replay the runner exported with its overlay burned in, when the walk kept one. */
export function caseReplayUrl(artifacts: readonly RunArtifact[]): string | null {
  return artifacts.find((artifact) => artifact.label === CASE_REPLAY_FILE)?.url ?? null;
}

export interface ConsoleLine {
  /** Epoch millisecond the recorder stamped, or null on a line it could not read. */
  atMs: number | null;
  /** Null on a line the recorder did not write, which has no level to report. */
  level: string | null;
  text: string;
}

/**
 * The console file is JSONL of `{at, level, text}`. A line the recorder did
 * not write reads raw rather than being dropped — a bundle that cannot be
 * parsed is still evidence.
 */
export function parseConsoleLines(body: string): ConsoleLine[] {
  return body.split("\n").flatMap<ConsoleLine>((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    try {
      const entry: unknown = JSON.parse(trimmed);
      // The recorder writes one object per line. Anything else reads raw, which
      // is what a `null` line did before by throwing into the catch below.
      if (!isRecord(entry)) return [{ atMs: null, level: null, text: trimmed }];
      return [{
        atMs: typeof entry.at === "number" ? entry.at : null,
        level: typeof entry.level === "string" ? entry.level : "log",
        text: typeof entry.text === "string" ? entry.text : trimmed,
      }];
    } catch {
      return [{ atMs: null, level: null, text: trimmed }];
    }
  });
}

/**
 * The same file as one block of text — level first, so an error is findable
 * without reading every line. The run card's console fold reads it this way.
 */
export function formatConsoleLines(body: string): string {
  return parseConsoleLines(body)
    .map((line) => (line.level === null ? line.text : `${line.level.padEnd(7)}${line.text}`))
    .join("\n");
}
