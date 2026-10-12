/**
 * What an Agent action on the page may be named. The runner draws a pointer
 * only for a browser tool it maps onto one of these (runner agent-pointer.mjs),
 * and the playback document keeps a pointer only when its action is one of
 * them (browser-recording-playback.ts), so every page that draws the marks
 * reads this one vocabulary and no free text.
 */
export const AGENT_POINTER_ACTIONS = Object.freeze([
  "click", "dblclick", "hover", "fill", "type", "check", "uncheck", "select", "focus", "scroll",
]);
