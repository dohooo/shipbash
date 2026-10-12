/**
 * A Project's one live Sandbox slot, the way both hand sign-ins hold it: the
 * authentication handoff and the sign-in takeover. Each row names its
 * Sandbox and the command running its browser once they exist; a claim with
 * no Sandbox yet is fresh for a grace period, and after it was left by a
 * Function that died.
 */
import { hostedConfiguration } from "@shipbash/control-plane/configuration";
import type { RuntimeBundle } from "@shipbash/control-plane/vercel-sandbox-dispatch/runtime-bundle";

import { isRecord } from "./is-record";
import { CLAIM_GRACE_MS } from "./production-human-auth-paths";
import {
  defaultSandboxFactory,
  discardSandbox,
  sandboxHttpStatus,
  type ProductionHumanAuthSandbox,
  type ProductionHumanAuthSandboxFactory,
} from "./production-human-auth-sandbox";

/** What a slot's row says about its Sandbox. */
interface SlotRow {
  sandboxName: string | null;
  commandId: string | null;
  startedAt: string;
}

/** The slot's Sandbox with its browser command still running, or null when it is dead or was never started. */
export async function liveSandbox(
  factory: ProductionHumanAuthSandboxFactory,
  row: SlotRow,
): Promise<ProductionHumanAuthSandbox | null> {
  if (row.sandboxName === null || row.commandId === null) return null;
  const sandbox = await factory.get(row.sandboxName);
  if (sandbox?.status !== "running") return null;
  try {
    return (await sandbox.getCommand(row.commandId)).exitCode === null ? sandbox : null;
  } catch (error) {
    if (sandboxHttpStatus(error) === 404) return null;
    throw error;
  }
}

/** A claim still inside its grace period: another Function is bringing its browser up. */
export function slotClaimIsFresh(row: SlotRow): boolean {
  return row.sandboxName === null && Date.now() - Date.parse(row.startedAt) < CLAIM_GRACE_MS;
}

/** Deletes the slot's Sandbox, if it ever had one. */
export async function discardSlotSandbox(factory: ProductionHumanAuthSandboxFactory, row: SlotRow): Promise<void> {
  if (row.sandboxName !== null) {
    const sandbox = await factory.get(row.sandboxName);
    if (sandbox) await discardSandbox(sandbox);
  }
}

export interface ResolvedSandboxDependencies<Dependencies> {
  dependencies: Dependencies;
  factory: ProductionHumanAuthSandboxFactory;
  runtimeBundle: RuntimeBundle | null;
}

/** The Sandbox client and the release's code layer, defaulted the way production runs when the caller passes none. */
export async function resolveSandboxDependencies<
  Dependencies extends { sandboxFactory?: ProductionHumanAuthSandboxFactory; runtimeBundle?: RuntimeBundle | null },
>(dependencies: Dependencies): Promise<ResolvedSandboxDependencies<Dependencies>> {
  return {
    dependencies,
    factory: dependencies.sandboxFactory ?? await defaultSandboxFactory(),
    runtimeBundle: dependencies.runtimeBundle === undefined
      ? hostedConfiguration().hosted.runtimeBundle
      : dependencies.runtimeBundle,
  };
}

/** The saved sign-in as the runner seals it: a JSON object, or nothing to continue from. */
export function savedState(stateJsonText: string | null): Record<string, unknown> | null {
  if (stateJsonText === null) return null;
  const state: unknown = JSON.parse(stateJsonText);
  if (!isRecord(state)) throw new Error("The saved Target Auth state is not a JSON object.");
  return state;
}
