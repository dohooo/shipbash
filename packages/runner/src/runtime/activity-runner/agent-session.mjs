// The Activity agent's session assembly: the opening prompt (Suite snapshot,
// knowledge context) and the pi session turn that runs it.
// An Activity runs as the persistent pi session in pi-agent-slot.mjs; there
// is no other agent engine.
import { buildActivityProductionPromptForRuntime } from "@shipbash/contracts/runtime/production-prompts.mjs";
import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import { writeFile } from "node:fs/promises";

import { historyPathsFrom } from "../history-records.mjs";
import { activityOpeningNote } from "../history-tools.mjs";
import { runPiAgentSession } from "./pi-agent-slot.mjs";
import {
  AGENT_RESULT_PATH,
  CONTROL_ROOT,
  DEFAULT_TIMEOUT_MS,
  activityDeadlineRemainingMs,
  activityWallMs,
  validateActivity,
} from "./environment.mjs";
import { redactString } from "./redaction.mjs";
import { deliveryCheck } from "./results.mjs";
import { emit } from "./state.mjs";

function promptSuites(activity) {
  return activity.suites.map((suite) => ({
    id: suite.id,
    name: suite.name,
    definitionRevision: suite.definitionRevision,
    cases: suite.cases.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      // The agent proposes instruction and goal text only; canonical {id, ...}
      // anchoring is reapplied by the service when a proposal is persisted.
      // Checkpoint anchors surface as 1-based step numbers.
      steps: candidate.steps.map((step) => step.instruction),
      category: candidate.category,
      checkpoints: candidate.checkpoints.map((checkpoint) => {
        if (checkpoint.afterStep === undefined) return { goal: checkpoint.goal };
        if (checkpoint.afterStep === null) return { goal: checkpoint.goal, afterStep: null };
        const stepNumber = candidate.steps.findIndex((step) => step.id === checkpoint.afterStep) + 1;
        return stepNumber > 0
          ? { goal: checkpoint.goal, afterStep: stepNumber }
          : { goal: checkpoint.goal };
      }),
      whyItMatters: candidate.whyItMatters,
      enabled: candidate.enabled,
      archived: candidate.archived,
    })),
  }));
}

// What a waking leg reads first. All three open the same way; what the
// owner's words then ask for differs by surface: Discovery may change its
// list, a walk carries on with its brief, and the unattended kinds deliver
// again.
const WOKEN = "You are awake again in the same conversation. The browser has been reopened on the product with any saved sign-in state applied — a public landing page or a rendered sign-in form is not evidence about your session, the signed-in entry is: reach it before you judge, and never judge from this sentence.";
const DISCOVERY_RESUME = `${WOKEN} Whatever woke you — a completed sign-in, or the owner speaking after your last round — the user messages below this line are why: respond to them and continue from what you already know. If the messages only need an answer — no new exploration, no Journey changes — reply — the answer, no preamble — and stop; your Journey list stays as it is. If they ask for changes to the Journeys, make them with the journey tools (add_journey / update_journey / remove_journey), say what you changed, one line per Journey, and stop. If they ask you to try something in the product — a reset path, a test-only entry, a way to walk a flow again — walk it now and judge it by the state it leaves, record the route, keep what worked the way the message tells you, and say plainly in your closing message what worked, what you saw, and what you did not do; then stop.`;
const WALK_RESUME = `${WOKEN} Whatever woke you — a completed sign-in, or a message below this line — carry on with what your brief asks from where the walk stopped. A walk that reached its goal is drafted with the journey tools — add_journey, or update_journey for a Journey this walk drafted before. Report as your brief's closing message says, then stop.`;
const UNATTENDED_RESUME = `${WOKEN} Whatever woke you — a completed sign-in, or the owner speaking after your last delivery — the user messages below this line are why: respond to them and continue from what you already know. If the messages only need an answer — no new exploration, no new deliverable — reply, then call deliver_result with status completed and an empty proposals list, summarizing in one line what you answered; your earlier delivery stays in place. Reserve needs_attention for a round that is actually stuck.`;

/** @param {unknown} kind */
function resumePromptFor(kind) {
  const surface = activityKnowledgeSurface(kind);
  // The chat itself runs on the host: a leg of it that reaches a Sandbox is a walk.
  if (surface.inChat) return WALK_RESUME;
  return surface.interacts ? DISCOVERY_RESUME : UNATTENDED_RESUME;
}

export function buildActivityPrompt(activityValue) {
  const activity = validateActivity(activityValue);
  return buildActivityProductionPromptForRuntime(activity, promptSuites(activity));
}

/**
 * The leg's wall-clock ceiling, with the warning for a Sandbox deadline too
 * near to close under: the leg then runs on its budget alone, and the
 * teardown may end it first — exactly what the ceiling exists to prevent, so
 * the record must say it happened.
 */
function wallClockForLeg() {
  const wallMs = activityWallMs();
  const remaining = activityDeadlineRemainingMs();
  if (remaining !== null && wallMs === null) {
    emit("warning", "No wall-clock room is left for this leg", {
      bodyMarkdown: `The Sandbox deadline is ${String(Math.round(remaining / 1_000))} seconds away; the leg runs on its budget alone and the teardown may end it first.`,
      safeData: { category: "timeout", event: "wall_clock_exhausted", deadlineRemainingMs: remaining },
    });
  }
  return wallMs;
}

/**
 * One agent turn: the pi session engine runs a persistent session whose
 * transcript survives on the task's session mount. It returns a
 * process-shaped outcome and leaves the structured result document at
 * AGENT_RESULT_PATH for the shared validation path.
 */
export async function executeAgentTurn({ activity, env, publishProjected, assistantFeed, onActionStart, onAction, onAgentFailure, onSessionOpened = () => undefined, firstFrameContext = null, wallConfirmed = false, entryCheck = null, terminal }) {
  // The brief opens with the Project's newest run and session when there are any.
  const historyNote = await activityOpeningNote(historyPathsFrom({ controlRoot: CONTROL_ROOT }));
  const brief = buildActivityPrompt(activity);
  const outcome = await runPiAgentSession({
    activity,
    env,
    terminal,
    onSessionOpened,
    onActionStart,
    onAction,
    assistantFeed,
    firstFrameContext,
    wallConfirmed,
    entryCheck,
    checkDelivery: deliveryCheck(activity),
    initialPrompt: historyNote ? `${historyNote}\n\n${brief}` : brief,
    resumePrompt: resumePromptFor(activity.kind),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    wallMs: wallClockForLeg(),
    onAssistantText: (text) => {
      publishProjected({
        kind: "goal",
        label: "Agent update",
        bodyMarkdown: text,
        safeData: { event: "agent_output", phase: "interim" },
      });
    },
    onFailure: (message) => {
      onAgentFailure(redactString(message).slice(0, 500));
    },
  });
  if (outcome.resultText) {
    await writeFile(AGENT_RESULT_PATH, outcome.resultText, { mode: 0o600 });
  }
  return { code: outcome.code, signal: null, canceled: outcome.canceled, timedOut: outcome.timedOut, waitedMs: outcome.waitedMs };
}
