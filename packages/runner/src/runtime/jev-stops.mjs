// Why a Jev walk (jev-executor.mjs) ends before every checkpoint passes, one
// vocabulary for the walk and for the lanes' evidence gates that stop it, by
// the code its summary event keeps (jev-verification.mjs): the text is for the supervising agent,
// the code lets a Run's events count hand-backs by cause without storing any
// page text. A walk stopped by a JevStop ends with that stop's reason; any
// other error that ends it is `interrupted`.
export const JEV_REASONS = Object.freeze({
  owner_input: "Owner input or interruption is waiting; return to the supervising agent.",
  origin_changed: "Origin changed; the supervising agent must inspect the new destination.",
  page_too_large: "The page exceeds the bounded context limit.",
  page_stopped: "Page stopped progressing; inspect before repeating any operation.",
  accumulated_evidence: "Accumulated evidence needs supervising-agent review.",
  budget: "Bounded execution budget reached.",
  unsupported_options: "The page requires actions or credentials outside the supported option set.",
  none_chosen: "No supported next action; ask the supervising agent.",
  stayed_busy: "The page stayed busy through every wait and never moved; inspect it before repeating any operation.",
  command_running: "The terminal's command was still running, its screen unchanged for a minute; watch it with terminal_read before repeating any operation.",
  no_step_left: "No step is left to take and the page settles no verdict; inspect it before repeating any operation.",
  checkpoint_failed: "Observed checkpoint failure.",
  // Refused by the step ledger (jev-steps.mjs) before the refused input
  // reached the page; `steps` in the record names the step and what was taken
  // for each.
  step_needs_text: "A step types text the Journey does not give in double quotes, so the walk typed only what that step quotes and took no action past it; that step and the rest are the supervising agent's.",
  step_skipped: "The next action belongs to a later step while an earlier step that needs an action has none; continue from that step.",
  steps_not_taken: "Every checkpoint passed, but a step that needs an action was never taken; take it, and judge what it changes.",
  // Stopped by either lane's evidence gate (suite-runner/case-agent.mjs,
  // activity-runner/evidence-capture.mjs), by why the step has no picture
  // (evidence-frames.mjs): the recording lost it, the browser is gone, or the
  // step failed on a browser that has stopped answering.
  evidence_not_retained: "Step evidence was not retained; return to the supervising agent.",
  browser_gone: "The browser this walk was driving is gone; return to the supervising agent.",
  browser_unresponsive: "ShipBash's browser has stopped answering, a fault on ShipBash's side rather than the product's; return to the supervising agent.",
});

/** Stops a walk for one of the reasons above, from the walk itself or a caller's hook. */
export class JevStop extends Error {
  /**
   * @param {keyof typeof JEV_REASONS} code
   * @param {string | null} detail what the reason's own words cannot know, after them
   */
  constructor(code, detail = null) {
    super(detail ? `${JEV_REASONS[code]} ${detail}` : JEV_REASONS[code]);
    this.name = "JevStop";
    this.code = code;
  }
}

/**
 * The stop for a browser step the evidence recorder kept no picture of: its
 * capture's answer says why, in a code of the table above, and how long the
 * browser had been silent when that is the reason.
 * @param {import("./evidence-frames.mjs").StepMissing} missing
 */
export function evidenceStop(missing) {
  return new JevStop(missing.reason, "silentMs" in missing
    ? `It has not answered for at least ${String(Math.floor(missing.silentMs / 1_000))} s.`
    : null);
}

/** What an error that ends a walk hands back: a JevStop's own reason, and `interrupted` for any other. */
export function interruption(error) {
  if (error instanceof JevStop) return { reason: error.message, reasonCode: error.code };
  return {
    reason: `Execution interrupted: ${String(error instanceof Error ? error.message : error)}. Inspect current state before retrying any input.`,
    reasonCode: "interrupted",
  };
}
