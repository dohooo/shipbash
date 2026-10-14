import { jevJson } from "./jev-actions.mjs";
import { executeJevGoal, supervisorRecord } from "./jev-executor.mjs";
import { jevToolCaller } from "./jev-tools.mjs";

// The call's whole budget; an owner steer or a wrap-up ends it sooner.
const GOAL_BUDGET_MS = 90_000;

const INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "steps", "constraints", "checkpoints"],
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 500, description: "The outcome this segment reaches, in one sentence." },
    steps: {
      type: "array", minItems: 1, maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1000 },
      description:
        'The known steps in order, one action each, naming controls by the labels the page shows; no selectors. Every text to type and every option to pick goes in double quotes, exactly as typed, as in Fill Body with "Q3 planning notes"; labels stay unquoted. The executor types and picks only quoted text: at most 12 distinct quotes, each on one line with no double quote inside. A step whose text is not quoted is handed back: the executor types only the text it quotes and takes no action past it; text with a double quote or a line break is not for this tool: type it with agent_browser_fill. A terminal step reads run `<command exactly as typed>` or type `<text>` — a code span, verbatim, quotes and all — or press <key> by the name terminal_type gives it; every run starts a fresh shell in ~/work.',
    },
    constraints: {
      type: "string", minLength: 1, maxLength: 2000,
      description: "What the segment may not do or touch: the edges of what is authorized.",
    },
    checkpoints: {
      type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 500 },
      description: "Text conditions judged in order against the page, or the terminal's screen for one about the terminal; the segment completes when every one is observed.",
    },
  },
};

/** One sequential tool within the existing planning session, not another agent. */
export function jevDiscoveryTool(options) {
  return {
    name: "browser_execute_goal",
    label: "Execute a bounded browser goal",
    executionMode: "sequential",
    description:
      `Execute an understood authorized segment with at least two consecutive supported inputs in one call: labelled button/link/tab/menu item clicks, checkbox/switch/radio states, select and listbox choices and fills of the text the steps quote (the steps field's description gives the rule), Enter in a field holding quoted text, Escape, and reload, and in the sandbox terminal the commands, text and keys the steps write as code spans, with observable text checkpoints. Do single clicks and initial page inspection directly. Sliders, date pickers, hover-only menus, other key presses in the page, uploads, gestures, credentials and visual-only checks are unsupported; perform those with existing tools before delegating a supported segment. Stops within ${String(GOAL_BUDGET_MS / 1_000)} seconds, or sooner when the owner speaks or asks to wrap up, and returns JSON {status: completed|failed|handoff, reason, checklist (each checkpoint's status), steps (each step taken, handed back or not reached, with its actions), history (actions taken), evidence, decisions, requests} — partial progress at ambiguity or unquoted text. Inspect a failed checkpoint and whether its required actions occurred before calling it a product defect. Does not create Journeys, change priorities, ask the owner or manage sign-ins.`,
    parameters: INPUT,
    execute: async (_id, input, parentSignal) => {
      const initialRevision = options.revision?.();
      const signal = AbortSignal.any([AbortSignal.timeout(GOAL_BUDGET_MS), ...(parentSignal ? [parentSignal] : [])]);
      const result = await executeJevGoal(
        {
          goal: input.goal,
          steps: input.steps.map((instruction, index) => ({ id: `step-${String(index + 1)}`, instruction })),
          everyStep: true,
          constraints: input.constraints,
          checkpoints: input.checkpoints.map((goal, index) => ({ id: `goal-${index + 1}`, goal })),
        },
        {
          jev: options.jev,
          signal,
          redact: options.redact,
          choose: options.choose,
          readTerminal: options.readTerminal,
          shouldYield: () => options.stopping?.() || options.revision?.() !== initialRevision,
          onDecision: options.onDecision,
          call: jevToolCaller(options.tools, { signal, afterAction: options.afterAction }),
        },
      );
      await options.retain?.(jevJson(result, options.redact));
      return {
        content: [{ type: "text", text: jevJson(supervisorRecord(result), options.redact) }],
        details: { status: result.status, requests: result.requests },
      };
    },
  };
}
