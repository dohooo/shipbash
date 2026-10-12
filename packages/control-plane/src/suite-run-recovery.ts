import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { boundedText } from "./dispatch-worker-support.ts";
import { isRecord } from "./is-record.ts";
import { checklistTransition } from "./store/normalize.ts";
import {
  parseRuntimeCaseChecklist,
  parseRuntimeCodeEvidence,
} from "./dispatch-worker-runtime-parsing.ts";
import type { CaseChecklistItem, CaseRunTrust } from "./types.ts";

const RUNTIME_DIRECTORY_PREFIX = "shipbash-runner-";
const CASE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_RESULT_FILE_BYTES = 5 * 1024 * 1024;

export interface RecoveredCaseResult {
  verdict: "passed" | "failed" | "blocked";
  summary: string;
  failureReason: string | null;
  checklist: CaseChecklistItem[];
  trust: CaseRunTrust;
}

export interface RecoveredSuiteResults {
  outputDirectory: string;
  authDirectory: string;
  results: Map<string, RecoveredCaseResult>;
}

async function readJsonFile(path: string): Promise<unknown> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.size > MAX_RESULT_FILE_BYTES) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function recoveredCaseResult(value: unknown): RecoveredCaseResult | null {
  if (!isRecord(value)) return null;
  const record = value;
  const outcome = record.outcome;
  if (outcome !== "passed" && outcome !== "failed" && outcome !== "blocked") return null;
  let checklist: CaseChecklistItem[];
  try {
    checklist = parseRuntimeCaseChecklist(record.checklist);
  } catch {
    return null;
  }
  let trust: CaseRunTrust = { reproducedRuns: 1, codeEvidence: null };
  if (record.trust !== undefined) {
    if (!isRecord(record.trust)) {
      return null;
    }
    const trustRecord = record.trust;
    if (trustRecord.reproducedRuns !== 1 && trustRecord.reproducedRuns !== 2) return null;
    try {
      trust = {
        reproducedRuns: trustRecord.reproducedRuns,
        codeEvidence: parseRuntimeCodeEvidence(trustRecord.codeEvidence),
      };
    } catch {
      return null;
    }
  }
  return {
    verdict: outcome,
    summary: boundedText(record.summary, 8_000) ?? "Case execution completed.",
    failureReason: boundedText(record.failureReason, 2_000),
    checklist,
    trust,
  };
}

/**
 * Whether recovered results can legally complete a Case Run whose checklist
 * was already reported live before the interruption. When an interrupted
 * execution drifted from the stored checklist, recovery must fall back to a
 * normal re-run instead of failing the whole Run on the stability guard.
 */
export function recoveredChecklistCompatible(
  previous: readonly CaseChecklistItem[],
  next: readonly CaseChecklistItem[],
): boolean {
  try {
    checklistTransition([...previous], [...next]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the runtime directory of an interrupted prior Suite execution (for
 * example one whose Runner died before reporting back) and returns the
 * definitive Case results it already wrote. Returns null unless every
 * requested Case has a complete result, so partial evidence falls back to a
 * normal re-run.
 */
export async function findOrphanedSuiteResults(input: {
  temporaryParent: string;
  suiteRunId: string;
  caseIds: readonly string[];
}): Promise<RecoveredSuiteResults | null> {
  if (!input.caseIds.length) return null;
  if (input.caseIds.some((caseId) => !CASE_IDENTIFIER_PATTERN.test(caseId))) return null;
  const parent = resolve(input.temporaryParent);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => null);
  if (!entries) return null;
  const candidates: Array<{ runtimeDirectory: string; modifiedMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(RUNTIME_DIRECTORY_PREFIX)) continue;
    const runtimeDirectory = join(parent, entry.name);
    const metadata = await stat(runtimeDirectory).catch(() => null);
    if (!metadata?.isDirectory()) continue;
    candidates.push({ runtimeDirectory, modifiedMs: metadata.mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  for (const candidate of candidates) {
    const suiteInput = await readJsonFile(join(candidate.runtimeDirectory, "input", "suite.json"));
    if (!isRecord(suiteInput) || suiteInput.suiteRunId !== input.suiteRunId) {
      continue;
    }
    const outputDirectory = join(candidate.runtimeDirectory, "output");
    const results = new Map<string, RecoveredCaseResult>();
    for (const caseId of input.caseIds) {
      const parsed = recoveredCaseResult(
        await readJsonFile(join(outputDirectory, caseId, "result.json")),
      );
      if (!parsed) break;
      results.set(caseId, parsed);
    }
    if (results.size !== input.caseIds.length) continue;
    return {
      outputDirectory,
      authDirectory: join(candidate.runtimeDirectory, "control", "auth"),
      results,
    };
  }
  return null;
}
