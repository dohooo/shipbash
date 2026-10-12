// The case lane's half of the entry check (entry-check.mjs). The leg's facts
// travel by file under the attempt's own work directory — the directory the
// progress tools already know, because their checklist event file lives
// there: the arming file (the production URL) and the pages the sidecar saw
// go out, the refusal marker comes back, all at the fixed names in
// ENTRY_CHECK_FILES.
// Armed only for an attempt that loaded a sign-in state — without one there
// is no session for a sign-in form to stand over.
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPagesSeenRecord, ENTRY_CHECK_FILES, ENTRY_CHECK_OWNER_NOTE } from "../entry-check.mjs";
import { emit } from "./state.mjs";

/**
 * Arms the attempt before its agent starts: the arming file is on disk when
 * this resolves, so the server's first verdict already sees it.
 * @param {{ productionUrl: string, statePath: string | null, agentWorkDirectory: string }} attempt
 * @returns {Promise<{ pages: ReturnType<typeof createPagesSeenRecord>, refusedPath: string } | null>}
 */
export async function prepareCaseEntryCheck({ productionUrl, statePath, agentWorkDirectory }) {
  if (statePath === null) return null;
  await writeFile(join(agentWorkDirectory, ENTRY_CHECK_FILES.arming), `${JSON.stringify({ productionUrl })}\n`, { mode: 0o600 });
  return {
    pages: createPagesSeenRecord(join(agentWorkDirectory, ENTRY_CHECK_FILES.pages), writeFile),
    refusedPath: join(agentWorkDirectory, ENTRY_CHECK_FILES.refused),
  };
}

/**
 * The owner's one line when the server refused a doorstep verdict during the
 * walk; the result passes through untouched.
 * @template T
 * @param {{ refusedPath: string } | null} entryCheck
 * @param {Record<string, unknown>} context
 * @param {T} result
 * @returns {T}
 */
export function reportEntryCheckRefusal(entryCheck, context, result) {
  if (entryCheck && existsSync(entryCheck.refusedPath)) {
    emit("case", "case_entry_check_required", { ...context, message: ENTRY_CHECK_OWNER_NOTE });
  }
  return result;
}
