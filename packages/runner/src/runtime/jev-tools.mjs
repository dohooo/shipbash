/**
 * @typedef {{ type: string, text?: string }} ToolContent
 * @typedef {{ isError?: boolean, content: ToolContent[] }} ToolResult
 * @typedef {{ name: string, execute(id: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> }} BrowserTool
 * @typedef {{ type: string, toolName: string, args: Record<string, unknown>, toolCallId: string, isError?: boolean }} ToolEvent
 */

/** Jev's calls carry this prefix in their tool call ids; the supervising agent's never do. */
const JEV_CALL_PREFIX = "jev";

/** Whether a tool call id names a call Jev made. */
export function isJevCall(toolCallId) {
  return typeof toolCallId === "string" && toolCallId.startsWith(`${JEV_CALL_PREFIX}:`);
}

/**
 * Execute the existing browser tools with the same cancellation and evidence
 * boundary for both callers. An error never implies that input was not sent.
 * @param {BrowserTool[]} tools
 * @param {{ signal: AbortSignal, onEvent?: (event: ToolEvent) => Promise<void>, afterAction?: () => Promise<void> }} options
 */
export function jevToolCaller(tools, { signal, onEvent, afterAction }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let sequence = 0;
  return async (toolName, args) => {
    signal.throwIfAborted();
    const tool = byName.get(toolName);
    if (!tool) throw new Error(`Unsupported browser operation: ${toolName}`);
    const event = { toolName, args, toolCallId: `${JEV_CALL_PREFIX}:${++sequence}` };
    await onEvent?.({ ...event, type: "tool_execution_start" });
    let failed = true;
    try {
      const result = await tool.execute(event.toolCallId, args, signal);
      if (result.isError) throw new Error("Browser operation failed; its effect may be uncertain.");
      failed = false;
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    } finally {
      await onEvent?.({ ...event, type: "tool_execution_end", isError: failed });
      await afterAction?.();
    }
  };
}
