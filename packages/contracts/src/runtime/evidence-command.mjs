/**
 * The one command that hands ShipBash's evidence to the owner's coding agent:
 * the CLI pulls what a Journey run (its `case_run_…` id), a walk or a
 * Discovery (its Activity id) left into a folder of its own and says where.
 * Every surface that offers it — the Slack block under a recording, the
 * agents' prompts — builds it here, so they never disagree with the CLI.
 *
 * @param {string} id
 * @returns {string}
 */
export function evidenceCommand(id) {
  return `npx shipbash evidence ${id}`;
}

/** The Activities whose evidence the command pulls by their id: those that walk the product. */
export const EVIDENCE_ACTIVITY_KINDS = Object.freeze(["walk", "initial_discovery", "generate_cases"]);
