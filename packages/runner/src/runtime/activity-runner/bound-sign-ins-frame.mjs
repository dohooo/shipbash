import { savedWaysInList, savedWaysInRule } from "@shipbash/contracts/runtime/discovery-surface.mjs";

/**
 * The first frame's instruction at a wall the project has saved ways into:
 * the one rule the brief states too (savedWaysInRule), then the handoff for
 * when the saved ways cannot get the agent in.
 * @param {ReadonlyArray<{ method: string, label?: string | null }>} signIns
 * @param {boolean} asks
 */
export function boundSignInsInstruction(signIns, asks) {
  return `This project has saved ways in: ${savedWaysInList(signIns)}. At a login gate, ${savedWaysInRule(asks)} `
    + "If the available credentials cannot complete authentication, call request_authentication with the account, the "
    + "observed problem and what the owner needs to do, as your final act. Never put credentials in narration, reports or knowledge.";
}
