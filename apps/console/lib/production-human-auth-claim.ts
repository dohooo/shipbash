/**
 * The rule that makes one sign-in at a time the truth: a Project runs one
 * handoff, and the control plane's row for it is what two requests agree on.
 *
 * The row is claimed before any Sandbox exists, so a second request finds it
 * and stops; it names the viewer once the viewer answers, so a later request
 * for the same target finds its browser instead of opening another. A row
 * whose viewer is dead — its Sandbox gone or stopped, its command exited —
 * or whose claim never got a viewer inside the grace period was left by a
 * Function that died, and is taken over. So is one whose run or Activity no
 * longer waits on a person: it resumed (a way in its runs use turned ready)
 * or ended without the viewer's own "I'm done" or cancel.
 */
import type { ActorStore } from "@shipbash/control-plane/store/actor-store";
import type { TargetAuthHandoff, TargetAuthHandoffAccess } from "@shipbash/control-plane/store/target-auth-handoffs";

import type { ScopedAuthInput } from "./production-human-auth-identity";
import type { ProductionHumanAuthSandbox, ProductionHumanAuthSandboxFactory } from "./production-human-auth-sandbox";
import { discardSlotSandbox, liveSandbox, slotClaimIsFresh } from "./production-sandbox-slot";

const HANDOFF_ACTIVE = "Another authentication handoff is active for this Project.";
export const HANDOFF_NOT_ACTIVE = "The requested authentication handoff is not active.";

interface HandoffSlotDependencies {
  handoffs: TargetAuthHandoffAccess;
  factory: ProductionHumanAuthSandboxFactory;
}

/** What a claim reads besides the slot: whether the slot's target still waits on a person. */
type HandoffTargetStatusStore = Pick<ActorStore, "getSuiteRunStatus" | "getActivityStatus">;

/** One status read: a run waits at its sign-in; an Activity at its sign-in or at a question its viewer answers. */
async function targetWaits(store: HandoffTargetStatusStore, actor: ScopedAuthInput["actor"], handoff: TargetAuthHandoff): Promise<boolean> {
  if (handoff.targetKind === "run") {
    return await store.getSuiteRunStatus(actor, handoff.teamId, handoff.projectId, handoff.targetId) === "waiting_for_auth";
  }
  const status = await store.getActivityStatus(actor, handoff.teamId, handoff.projectId, handoff.targetId);
  return status === "waiting_for_auth" || status === "waiting_for_input";
}

export function sameTarget(handoff: TargetAuthHandoff, input: ScopedAuthInput): boolean {
  return handoff.teamId === input.teamId
    && handoff.targetKind === input.targetKind
    && handoff.targetId === input.targetId;
}

/** Ends a handoff for good: its Sandbox, if it ever had one, and its row. */
export async function releaseHandoff(deps: HandoffSlotDependencies, handoff: TargetAuthHandoff): Promise<void> {
  await discardSlotSandbox(deps.factory, handoff);
  await deps.handoffs.release(handoff.projectId);
}

/**
 * Takes the Project's handoff slot for this target. Answers the running
 * viewer when this same target already has one; takes over a slot whose
 * handoff is dead or whose target no longer waits; refuses one another
 * waiting target is using.
 */
export async function claimHandoff(
  deps: HandoffSlotDependencies & { store: HandoffTargetStatusStore },
  input: ScopedAuthInput,
): Promise<ProductionHumanAuthSandbox | null> {
  const existing = await deps.handoffs.read(input.projectId);
  if (existing) {
    const live = await liveSandbox(deps.factory, existing);
    if (live && sameTarget(existing, input)) return live;
    if ((live || slotClaimIsFresh(existing)) && await targetWaits(deps.store, input.actor, existing)) {
      throw new Error(HANDOFF_ACTIVE);
    }
    console.warn("[shipbash:human-auth] Taking over an authentication handoff that is dead or no longer waited on.", {
      targetKind: existing.targetKind,
      targetId: existing.targetId,
    });
    await releaseHandoff(deps, existing);
  }
  if (!await deps.handoffs.claim(input)) throw new Error(HANDOFF_ACTIVE);
  return null;
}

/** This target's handoff with a viewer behind it, the way complete and cancel need it. */
export async function ownedHandoff(
  handoffs: TargetAuthHandoffAccess,
  input: ScopedAuthInput,
): Promise<(TargetAuthHandoff & { sandboxName: string; commandId: string }) | null> {
  const handoff = await handoffs.read(input.projectId);
  if (!handoff || !sameTarget(handoff, input) || handoff.sandboxName === null || handoff.commandId === null) return null;
  return { ...handoff, sandboxName: handoff.sandboxName, commandId: handoff.commandId };
}
