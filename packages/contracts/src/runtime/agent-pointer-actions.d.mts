export declare const AGENT_POINTER_ACTIONS: readonly [
  "click", "dblclick", "hover", "fill", "type", "check", "uncheck", "select", "focus", "scroll",
];

export type AgentPointerAction = (typeof AGENT_POINTER_ACTIONS)[number];
