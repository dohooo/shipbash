/**
 * The agent's batch: several of its own browser tool calls in one turn, for
 * the step a turn is too slow for — the confirmation a click reveals and takes
 * back within seconds (CONFIRM_WINDOW in tool-craft.mjs).
 *
 * agent-browser's own batch runs raw CLI commands inside the daemon, where the
 * proxy's reachability gate and cursor never see them, so the proxy refuses it
 * (agent-browser-catalogue.mjs). This one performs each call through the lane's
 * tool of that name: the MCP proxy gates it, flies the cursor to its target
 * and settles its page, the activity feed gets its row and the walk its entry,
 * as when the agent makes the call alone. Only the turn in between is gone.
 * The first call that fails stops the batch, because every call after it was
 * chosen for the page that call was meant to produce.
 */
import { CONFIRM_WINDOW } from "./tool-craft.mjs";

export const BATCH_TOOL = "agent_browser_batch";

const DESCRIPTION =
  "Performs several of your browser tool calls in order, in one turn. Each call gets the same reachability check, cursor and settled page it gets on its own, and the batch stops at the first call that fails or is refused; the calls after it do not run. Returns each call's result in order. "
  + CONFIRM_WINDOW;

/** @param {{ content: Array<{ type: string, text?: string }> }} result */
function resultText(result) {
  return result.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * @typedef {{ content: Array<{ type: string, text?: string, data?: string, mimeType?: string }> }} ToolResult
 * @typedef {{ name: string, execute: (toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult> }} BrowserTool
 * @param {BrowserTool[]} tools the lane's browser tools, as the agent calls them
 */
export function browserBatchTool(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    name: BATCH_TOOL,
    label: BATCH_TOOL,
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          minItems: 1,
          description: "The calls, in the order they run.",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "The name of a browser tool in your catalogue, such as agent_browser_click." },
              args: { type: "object", description: "That tool's own arguments." },
            },
            required: ["tool", "args"],
            additionalProperties: false,
          },
        },
      },
      required: ["calls"],
      additionalProperties: false,
    },
    executionMode: "sequential",
    /** @param {string} toolCallId @param {{ calls: Array<{ tool: string, args: Record<string, unknown> }> }} params @param {AbortSignal} [signal] */
    execute: async (toolCallId, { calls }, signal) => {
      const steps = calls.map((call, index) => ({ ...call, label: `${String(index + 1)}. ${call.tool}` }));
      const unknown = steps.find((step) => !byName.has(step.tool));
      if (unknown) throw new Error(`${unknown.label} is not a browser tool in your catalogue; no call ran.`);
      const done = [];
      // A screenshot the batch takes reaches the model as it would alone, after the batch's text.
      const images = [];
      for (const [index, step] of steps.entries()) {
        let result;
        try {
          result = await byName.get(step.tool).execute(`${toolCallId}.${String(index + 1)}`, step.args, signal);
        } catch (error) {
          const rest = steps.length - index - 1;
          const skipped = rest > 0 ? [`The ${String(rest)} call${rest === 1 ? "" : "s"} after it did not run.`] : [];
          const failure = `${step.label} failed: ${error instanceof Error ? error.message : String(error)}`;
          throw new Error([...done, failure, ...skipped].join("\n\n"), { cause: error });
        }
        done.push(`${step.label}\n${resultText(result)}`);
        images.push(...result.content.filter((part) => part.type === "image"));
      }
      return { content: [{ type: "text", text: done.join("\n\n") }, ...images], details: undefined };
    },
  };
}
