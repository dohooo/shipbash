// The rules most often forgotten mid-walk
// are handed over at the moment they apply, riding the snapshot the agent is
// already reading. Each note fires once per distinct page state — a reminder
// that repeats on every action is noise the agent learns to skip.
import { createHash } from "node:crypto";

const CONFIG_CHOICE_PATTERN =
  /install|select repositor|choose (?:a |your )?plan|connect (?:a |your )?(?:data )?(?:source|provider)|which .{0,40}(?:import|connect)/iu;
const REPEAT_NUDGE_THRESHOLD = 3;
const CONFIG_CHOICE_NOTE =
  "[ShipBash harness] This page looks like a configuration choice with product meaning. Check the knowledge you carry for an existing answer; when none exists, the choice is the owner's: ask it, or record it in the result when no one can answer now (rule 4).";
const NO_PROGRESS_NOTE =
  "[ShipBash harness] The page has not visibly changed across several actions. Change your eyes — the full snapshot, the page text, or a screenshot — or ask, rather than repeating the same move (rules 2 and 6).";

/**
 * Which harness notes this observation has earned. Mutates `state`
 * ({ lastHash, repeats, noted: Set }) so each note fires once per page state.
 */
export function harnessGuidanceFor(snapshotText, state) {
  const notes = [];
  const hash = createHash("sha256").update(snapshotText).digest("hex");
  if (hash === state.lastHash) {
    state.repeats += 1;
  } else {
    state.lastHash = hash;
    state.repeats = 0;
  }
  if (CONFIG_CHOICE_PATTERN.test(snapshotText) && !state.noted.has(`config:${hash}`)) {
    state.noted.add(`config:${hash}`);
    notes.push(CONFIG_CHOICE_NOTE);
  }
  if (state.repeats === REPEAT_NUDGE_THRESHOLD - 1 && !state.noted.has(`stall:${hash}`)) {
    state.noted.add(`stall:${hash}`);
    notes.push(NO_PROGRESS_NOTE);
  }
  return notes;
}

/** One proxy process is one browsing session: a single held state suffices. */
export function createHarnessGuidance() {
  const state = { lastHash: "", repeats: 0, noted: new Set() };
  return (snapshotText) => harnessGuidanceFor(snapshotText, state);
}
