// The terminal tools as agent_action rows (toolClass "terminal"). The console
// follows the agent between its Browser and Terminal tabs on these rows
// (latestAgentSurface), and nothing else named the terminal: the progress
// channel only says a session opened, so Follow agent never left the browser
// while the agent typed. The target is the program's name
// alone — a command line may carry a token the description says to elide.
// A call on a background shell makes no row and no move on the walk's video:
// no viewer is shown that shell, so Follow agent must not go looking for it.
import { isBackgroundTerminalCall } from "@shipbash/contracts/runtime/attention-track.mjs";
import { isRecord } from "@shipbash/contracts/runtime/contract-values.mjs";

import { TERMINAL_TOOL_NAMES } from "../terminal-tools.mjs";
import { emit, toolSummaryBudgetRemaining } from "./state.mjs";
import { noteWalkRecordingAction } from "./walk-recording.mjs";

const VERBS = { terminal_run: "run", terminal_read: "read", terminal_type: "type" };

/** @param {string} name @param {unknown} args */
function terminalTarget(name, args) {
  const safeArgs = isRecord(args) ? args : {};
  if (name === "terminal_run" && typeof safeArgs.command === "string") {
    return safeArgs.command.trim().split(/\s+/u)[0]?.slice(0, 60) ?? "";
  }
  return typeof safeArgs.sessionId === "string" ? safeArgs.sessionId.slice(0, 60) : "";
}

/** @param {string} name @param {unknown} args */
const shownTerminalCall = (name, args) => TERMINAL_TOOL_NAMES.includes(name) && !isBackgroundTerminalCall(args);

/** The action callbacks for the progress tools: only the terminal trio speaks, and only about a shell a viewer is shown. */
export function terminalActionEmitter() {
  return {
    /** @param {string} name @param {unknown} args */
    onActionStart: (name, args) => {
      if (!shownTerminalCall(name, args) || toolSummaryBudgetRemaining() < 2) return;
      emit("tool_summary", "Terminal action started", {
        safeData: { tool: name, status: "started", verb: VERBS[name], target: terminalTarget(name, args) },
      });
    },
    /** @param {string} name @param {unknown} args @param {number} ms @param {"ok" | "fail"} state @param {string} toolCallId */
    onAction: (name, args, ms, state, toolCallId) => {
      if (!shownTerminalCall(name, args)) return;
      noteWalkRecordingAction(name, args, ms, toolCallId);
      emit("tool_summary", `Terminal · ${VERBS[name]}`, {
        safeData: {
          event: "agent_action",
          toolClass: "terminal",
          verb: VERBS[name],
          target: terminalTarget(name, args),
          ms: Math.max(0, Math.round(ms)),
          state,
          milestoneId: null,
        },
      });
    },
  };
}
