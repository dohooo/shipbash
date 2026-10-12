/**
 * Case artifact capture and failure forensics: the redacted JSON artifacts,
 * the diagnostics bundle that outlives the container, the public-copy gate a
 * result passes on its way to a reader, and the cheap browser post-mortem
 * probes. The factory binds the runner's agentBrowser, emit, and redaction;
 * the /proc probes are pure and exported as-is.
 */
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseLastJson } from "./agent-browser-cli.mjs";
import { screencastBlackedOut } from "./screencast-blackout.mjs";
import { CHECKPOINT_FAULT_FALLBACK, HARNESS_FAULT_FALLBACK, sanitizePublicSentence } from "@shipbash/contracts/runtime/public-copy.mjs";

/**
 * Two facts that separate a crash from a deliberate replacement: whether any
 * Chromium is still alive, and whether the shared-memory file the renderer
 * needs was exhausted. Both are cheap, synchronous and never throw.
 */
export function countChromiumProcesses() {
  try {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/u.test(entry))
      .filter((pid) => {
        try {
          return /chrom/iu.test(readFileSync(`/proc/${pid}/comm`, "utf8"));
        } catch {
          return false;
        }
      }).length;
  } catch {
    return null;
  }
}

export function readShmBytes() {
  try {
    const stats = statfsSync("/dev/shm");
    return Number(stats.bsize) * Number(stats.blocks);
  } catch {
    return null;
  }
}

/**
 * Agent-browser stdout as a redacted artifact: the parsed document when the
 * output is JSON or ends in a JSON line, the redacted text otherwise.
 * @param {unknown} stdout
 * @param {(value: unknown) => unknown} redact
 * @returns {string}
 */
function redactedJsonArtifact(stdout, redact) {
  const normalized = String(stdout).trim();
  if (normalized.length === 0) {
    return "\n";
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    parsed = parseLastJson(normalized);
  }
  if (parsed !== null) {
    return `${JSON.stringify(redact(parsed), null, 2)}\n`;
  }
  return `${redact(normalized)}\n`;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>} true only when the file exists with bytes in it.
 */
async function nonEmptyFile(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/**
 * The public-copy rewrite itself: a sentence that names our own plumbing is
 * replaced with an honest fallback, and every rewritten field is named so the
 * caller can record the leak.
 * @param result the Case result on its way to a reader.
 * @returns the rewritten result, and the names of the fields that leaked.
 */
function sanitizePublicCopy(result) {
  const leakedFields = [];
  const clean = (field, value, fallback) => {
    if (value === null || value === undefined) return value;
    const sanitized = sanitizePublicSentence(value, fallback);
    if (sanitized !== value) leakedFields.push(field);
    return sanitized;
  };
  const sanitized = {
    ...result,
    summary: clean("summary", result.summary, HARNESS_FAULT_FALLBACK),
    failureReason: clean("failureReason", result.failureReason, HARNESS_FAULT_FALLBACK),
    checklist: (result.checklist ?? []).map((item, index) => ({
      ...item,
      reason: item.reason === null || item.reason === undefined
        ? item.reason
        : clean(`checklist.${String(index)}.reason`, item.reason, CHECKPOINT_FAULT_FALLBACK),
    })),
  };
  return { leakedFields, sanitized };
}

/**
 * A probe that failed is an event, never an exception: forensics must not
 * break the run they describe.
 * @param {(channel: string, name: string, payload: Record<string, unknown>) => void} emit
 * @param {(error: unknown) => string} safeError
 * @param {string} kind
 * @param {Record<string, unknown>} context
 * @param {unknown} error
 * @returns {void}
 */
function reportCaptureFailure(emit, safeError, kind, context, error) {
  emit("infrastructure", "artifact_capture_failed", { ...context, kind, message: safeError(error) });
}

/**
 * @param {number} attempt
 * @param {number} executionRound
 * @returns {string} the directory this execution round's artifacts belong in,
 * relative to the case's own output.
 */
function executionRoundDirectory(attempt, executionRound) {
  const attemptDirectory = `attempt-${attempt}`;
  return executionRound === 1
    ? attemptDirectory
    : join(attemptDirectory, `auth-validation-${executionRound - 1}`);
}

/**
 * @param {string} outputRoot
 * @param {string} caseRunId
 * @param {number} attempt
 * @param {number} executionRound
 * @returns {string} the directory this execution round's artifacts belong in.
 */
function caseArtifactPath(outputRoot, caseRunId, attempt, executionRound) {
  return join(outputRoot, caseRunId, executionRoundDirectory(attempt, executionRound));
}

export function createCaseArtifacts({ agentBrowser, emit, safeError, redactEventValue, outputRoot }) {
  function serializeRedactedJsonArtifact(stdout) {
    return redactedJsonArtifact(stdout, redactEventValue);
  }

  /**
   * Failure forensics must outlive the container. The bundle lands in the
   * case's artifact directory, which the host retains wholesale, so the same
   * facts that ride the event stream are also downloadable evidence.
   */
  async function writeFailureDiagnostics(artifactDirectory, envelope, context) {
    try {
      const path = join(artifactDirectory, "diagnostics.json");
      await writeFile(
        path,
        serializeRedactedJsonArtifact(JSON.stringify({ at: new Date().toISOString(), ...envelope })),
        { mode: 0o600 },
      );
      await emitArtifactIfPresent("diagnostics", path, context);
    } catch {
      // Forensics must never break the run they describe.
    }
  }

  /**
   * The last gate before a Case result reaches a reader: any sentence that
   * names our own plumbing is replaced with an honest harness-fault sentence,
   * and the fact that this happened is itself recorded — a leak here is a
   * ShipBash defect worth an event.
   */
  function sanitizeCaseResultCopy(result, context) {
    const { leakedFields, sanitized } = sanitizePublicCopy(result);
    if (leakedFields.length > 0) {
      emit("infrastructure", "public_copy_sanitized", {
        ...context,
        message: `Internal wording was kept out of the public result (${leakedFields.join(", ")}).`,
      });
    }
    return sanitized;
  }

  async function emitArtifactIfPresent(kind, path, context) {
    if (await nonEmptyFile(path)) {
      emit("browser", "artifact_saved", { ...context, kind, path });
    }
  }

  async function captureArtifacts(env, artifactDirectory, traceStarted, context) {
    const screenshotPath = join(artifactDirectory, "key-screenshot.png");
    const consolePath = join(artifactDirectory, "console.json");
    const errorsPath = join(artifactDirectory, "errors.json");
    const tracePath = join(artifactDirectory, "chrome-trace.json");

    // A case that ends while a one-time code may be on screen keeps no key
    // screenshot; the step screenshots before the code stand in for it.
    if (!screencastBlackedOut()) {
      try {
        await agentBrowser(["screenshot", "--full", screenshotPath], env, {
          cancelable: false,
          timeoutMs: 30_000,
        });
        await emitArtifactIfPresent("screenshot", screenshotPath, context);
      } catch (error) {
        reportCaptureFailure(emit, safeError, "screenshot", context, error);
      }
    }

    for (const [kind, command, path] of [
      ["console", ["console"], consolePath],
      ["errors", ["errors"], errorsPath],
    ]) {
      try {
        const result = await agentBrowser(command, env, {
          cancelable: false,
          timeoutMs: 30_000,
        });
        await writeFile(path, serializeRedactedJsonArtifact(result.stdout), { mode: 0o600 });
        await emitArtifactIfPresent(kind, path, context);
      } catch (error) {
        reportCaptureFailure(emit, safeError, kind, context, error);
      }
    }

    if (traceStarted) {
      try {
        await agentBrowser(["trace", "stop", tracePath], env, {
          cancelable: false,
          timeoutMs: 30_000,
        });
        await emitArtifactIfPresent("chrome_trace", tracePath, context);
      } catch (error) {
        reportCaptureFailure(emit, safeError, "chrome_trace", context, error);
      }
    }
  }

  function caseArtifactDirectory(caseRunId, attempt, executionRound) {
    return caseArtifactPath(outputRoot, caseRunId, attempt, executionRound);
  }

  return {
    serializeRedactedJsonArtifact,
    nonEmptyFile,
    writeFailureDiagnostics,
    sanitizeCaseResultCopy,
    emitArtifactIfPresent,
    captureArtifacts,
    caseArtifactDirectory,
  };
}
