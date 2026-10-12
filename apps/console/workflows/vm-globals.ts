const NEVER_ABORTED_SIGNAL = {
  aborted: false,
  reason: undefined,
  onabort: null,
  throwIfAborted() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
};

/**
 * Gives the Workflow VM the AbortController it lacks, so the workflow bundle loads.
 *
 * The bundle registers every Workflow serde class the console's routes import,
 * whether or not a workflow uses it, and Chat SDK's thread module is one: it
 * creates an AbortController when it loads (vercel/chat#969). The Workflow VM
 * has none, so without this every workflow run fails before its first step.
 * Nothing in a workflow aborts, so the signal here never does. Wherever Node
 * runs it (a step, a route) the real AbortController exists and it does nothing.
 *
 * The workflow file calls it at its top level: the bundle evaluates workflow
 * files before the serde classes, and the Workflow compiler drops a bare
 * side-effect import.
 */
export function provideAbortController(): void {
  if (typeof globalThis.AbortController !== "undefined") return;
  Object.defineProperty(globalThis, "AbortController", {
    configurable: true,
    writable: true,
    value: class AbortController {
      readonly signal = NEVER_ABORTED_SIGNAL;
      abort(): void {}
    },
  });
}
