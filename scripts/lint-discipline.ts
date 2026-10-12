import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { z } from "zod";

const ROOT = process.cwd();
const BASELINE_PATH = resolve(ROOT, "config/lint-discipline-baseline.json");
const TARGETS = [
  "apps/console/app/**/*.{ts,tsx}",
  "apps/console/components/**/*.{ts,tsx}",
  "apps/console/lib/**/*.ts",
  "apps/console/proxy.ts",
  "apps/console/workflows/**/*.ts",
  "apps/marketing/app/**/*.{ts,tsx}",
  "packages/cli/src/**/*.ts",
  "packages/contracts/src/**/*.{ts,js,mjs,mts}",
  "packages/control-plane/src/**/*.ts",
  "packages/runner/src/**/*.{ts,js,mjs}",
  "scripts/**/*.ts",
];
const METRIC_RULES = new Set(["complexity", "max-lines", "max-lines-per-function"]);

function lintCandidatePaths(): Set<string> {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT, encoding: "utf8" },
  );
  return new Set(output.split("\0").filter(Boolean));
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/**
 * A regenerated baseline is only as true as the tree it was measured on. Three
 * of the four ways it goes wrong leave the file looking plausible: a tree
 * behind main drops the entries a colleague just cleared and adds back the
 * ceilings their refactor removed; a half-finished rebase reports "no change";
 * a dirty tree records violations nobody is about to commit. So refuse, with
 * the reason, rather than write a file someone will read as fact.
 */
function assertRegenerable(): void {
  const refuse = (reason: string): never => {
    console.error(`Refusing to write the baseline: ${reason}.`);
    process.exit(1);
  };
  try {
    git("fetch", "origin", "main");
  } catch {
    refuse("`git fetch origin main` failed, so origin/main cannot be trusted");
  }
  const gitDirectory = git("rev-parse", "--git-dir");
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (existsSync(resolve(ROOT, gitDirectory, marker))) {
      refuse(`a rebase, merge or cherry-pick is in progress (${marker} exists)`);
    }
  }
  const dirty = git("status", "--porcelain");
  if (dirty) refuse(`the working tree is dirty:\n${dirty.split("\n").slice(0, 5).join("\n")}`);
  try {
    git("merge-base", "--is-ancestor", "origin/main", "HEAD");
  } catch {
    refuse("HEAD is not on top of origin/main — rebase first, or the baseline will undo someone else's batch");
  }
}

const baselineEntrySchema = z.object({
  ceiling: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
  file: z.string().min(1),
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/u),
  ruleId: z.string().min(1),
});
const baselineFileSchema = z.object({
  entries: z.array(baselineEntrySchema),
  thresholds: z.object({
    complexity: z.literal(15),
    fileLines: z.literal(400),
    functionLines: z.literal(100),
  }),
  version: z.literal(1),
});
type BaselineEntry = z.infer<typeof baselineEntrySchema>;
type BaselineFile = z.infer<typeof baselineFileSchema>;

interface Violation {
  actual?: number | undefined;
  column: number;
  file: string;
  fingerprint: string;
  line: number;
  message: string;
  ruleId: string;
}

function normalizeLine(line: string | undefined): string {
  return (line ?? "").trim().replaceAll(/\s+/gu, " ");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function metricActual(message: string): number | undefined {
  const match = message.match(/(?:has a complexity of |has too many lines \()([0-9]+)/u)
    ?? message.match(/File has too many lines \(([0-9]+)/u);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

async function collectViolations(results: ESLint.LintResult[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const result of results) {
    if (result.messages.length === 0) continue;
    const file = relative(ROOT, result.filePath).replaceAll("\\", "/");
    const lines = (await readFile(result.filePath, "utf8")).split(/\r?\n/u);
    for (const message of result.messages) {
      if (!message.ruleId) continue;
      const source = normalizeLine(lines[message.line - 1]);
      const isMetric = METRIC_RULES.has(message.ruleId);
      const subject = message.message
        .replaceAll(/[0-9]+/gu, "#")
        .replaceAll(/\s+/gu, " ");
      const fingerprint = isMetric
        ? digest(`${subject}|${source}`)
        : digest(`${source}|${message.column}`);
      violations.push({
        actual: isMetric ? metricActual(message.message) : undefined,
        column: message.column,
        file,
        fingerprint,
        line: message.line,
        message: message.message,
        ruleId: message.ruleId,
      });
    }
  }
  return violations.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.ruleId.localeCompare(right.ruleId)
    || left.fingerprint.localeCompare(right.fingerprint)
    || left.line - right.line
    || left.column - right.column
  ));
}

function baselineFrom(violations: Violation[]): BaselineFile {
  const entries = new Map<string, BaselineEntry>();
  for (const violation of violations) {
    const key = `${violation.file}|${violation.ruleId}|${violation.fingerprint}`;
    const existing = entries.get(key);
    if (violation.actual !== undefined) {
      entries.set(key, {
        ceiling: Math.max(existing?.ceiling ?? 0, violation.actual),
        file: violation.file,
        fingerprint: violation.fingerprint,
        ruleId: violation.ruleId,
      });
      continue;
    }
    entries.set(key, {
      count: (existing?.count ?? 0) + 1,
      file: violation.file,
      fingerprint: violation.fingerprint,
      ruleId: violation.ruleId,
    });
  }
  return {
    entries: [...entries.values()].sort((left, right) => (
      left.file.localeCompare(right.file)
      || left.ruleId.localeCompare(right.ruleId)
      || left.fingerprint.localeCompare(right.fingerprint)
    )),
    thresholds: { complexity: 15, fileLines: 400, functionLines: 100 },
    version: 1,
  };
}

async function main(): Promise<void> {
  // Before the lint, not after: the checks take a second and the lint takes
  // minutes, and a refusal is the same either way.
  if (process.argv.includes("--write-baseline")) assertRegenerable();
  const eslint = new ESLint({ errorOnUnmatchedPattern: false });
  const candidates = lintCandidatePaths();
  const results = (await eslint.lintFiles(TARGETS)).filter((result) => (
    candidates.has(relative(ROOT, result.filePath).replaceAll("\\", "/"))
  ));
  const violations = await collectViolations(results);
  if (process.argv.includes("--write-baseline")) {
    const baseline = baselineFrom(violations);
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log(`Wrote ${baseline.entries.length} baseline allowances to ${relative(ROOT, BASELINE_PATH)}.`);
    return;
  }

  const baseline = baselineFileSchema.parse(JSON.parse(await readFile(BASELINE_PATH, "utf8")));
  const allowances = new Map(baseline.entries.map((entry) => (
    [`${entry.file}|${entry.ruleId}|${entry.fingerprint}`, { ...entry }]
  )));
  const newViolations: Violation[] = [];
  for (const violation of violations) {
    const key = `${violation.file}|${violation.ruleId}|${violation.fingerprint}`;
    const allowance = allowances.get(key);
    if (violation.actual !== undefined) {
      if (!allowance?.ceiling || violation.actual > allowance.ceiling) newViolations.push(violation);
      continue;
    }
    if (!allowance?.count || allowance.count <= 0) {
      newViolations.push(violation);
      continue;
    }
    allowance.count -= 1;
  }

  const existingCount = violations.length - newViolations.length;
  console.log(`AI-discipline lint: ${existingCount} legacy violation${existingCount === 1 ? "" : "s"} contained by baseline.`);
  if (newViolations.length === 0) {
    console.log("AI-discipline lint: no new or worsened violations.");
    return;
  }
  for (const violation of newViolations) {
    console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.ruleId} ${violation.message}`);
  }
  throw new Error(`AI-discipline lint rejected ${newViolations.length} new or worsened violation${newViolations.length === 1 ? "" : "s"}.`);
}

await main();
