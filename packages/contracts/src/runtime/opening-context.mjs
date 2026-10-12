/**
 * The opening context: what a run reads before its first action beside its
 * task, carried in one string in every lane — the testing context's own text,
 * then as much of what ShipBash already knows about the product as fits. One
 * budget holds it: the host packs to it (control-plane knowledge-context.ts),
 * and the run input contracts hold every lane to it (suite-contract.mjs,
 * activity-contracts.mjs and their host mirrors), so a Project's knowledge can
 * grow without a run input ever being refused for its length. What does not
 * fit is cut behind one line saying so, and recall_knowledge answers it from
 * the record.
 *
 * Without the shared budget, pasted knowledge could push a verification's
 * testing context past this limit and stop every run of the Project.
 */
export const OPENING_CONTEXT_LIMIT = 12_000;

/** The recall corpus's kind for a testing context the opening had to cut, beside the knowledge kinds. */
export const TESTING_CONTEXT_KIND = "testing_context";
