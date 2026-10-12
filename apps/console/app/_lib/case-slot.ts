/**
 * How a Case's role reads to the owner: a Journey has no slot; a hook runs
 * in one of four, and a per-journey hook may be around one Journey only.
 * The vocabulary is the contract's; an unreadable value is the default a
 * row written before hooks carries.
 */
import { caseRoleSchema, ownerConfirmationSchema } from "@shipbash/contracts/api/primitives";
import type { z } from "zod";

export type CaseRole = z.output<typeof caseRoleSchema>;
export type HookRole = Exclude<CaseRole, "journey">;
export type OwnerConfirmation = z.output<typeof ownerConfirmationSchema>;

/** The four slots in the order a run walks them. */
export const HOOK_ROLES: readonly HookRole[] = ["before_all", "before_each", "after_each", "after_all"];

const SLOT_LABELS: Record<HookRole, string> = {
  before_all: "Before every run",
  after_all: "After every run",
  before_each: "Before each journey",
  after_each: "After each journey",
};

export function readCaseRole(value: unknown): CaseRole {
  const parsed = caseRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : "journey";
}

export function readOwnerConfirmation(value: unknown): OwnerConfirmation {
  const parsed = ownerConfirmationSchema.safeParse(value);
  return parsed.success ? parsed.data : "not_needed";
}

/** The slot a hook runs in; null for a Journey. */
export function caseSlotLabel(role: CaseRole | undefined): string | null {
  return role === undefined || role === "journey" ? null : SLOT_LABELS[role];
}

export function isHookRole(role: CaseRole): role is HookRole {
  return role !== "journey";
}

/** A per-journey slot can be scoped to one Journey; a per-run slot runs once. */
export function perJourneySlot(role: CaseRole): boolean {
  return role === "before_each" || role === "after_each";
}
