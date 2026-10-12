/**
 * The role fields of a Case on the way into the store: its role (a Journey
 * or a setup/teardown hook), the Journey a per-journey hook is scoped
 * to, its repeat, and the owner confirmation a proposed hook carries.
 *
 * A scope arrives as a Case id (the API, an applied Proposal) or, from the
 * runtime, as the index of a Journey proposed in the same list
 * (scopeCandidateIndex); here it becomes the Case id the store writes. The
 * Journey it names must be in the same list with role journey — archived is
 * allowed, so an owner archiving a Journey can leave its hooks to the
 * save's cascade instead of dropping them by hand.
 */
import {
  assertScopeAllowed,
  validateCaseRole,
  validateOwnerConfirmation,
  validateRepeatForRole,
} from "@shipbash/contracts/runtime/case-role-contract.mjs";
import type { NormalizedSuiteCaseInput } from "./rows.ts";
import type { MutableSuiteCaseInput } from "../types.ts";

type CaseRoleFields = Pick<NormalizedSuiteCaseInput, "role" | "scopeCaseId" | "repeat" | "ownerConfirmation">;

function scopeFromIndex(index: number, ids: readonly string[], field: string): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= ids.length) {
    throw new Error(`${field} must name an entry of this list.`);
  }
  return ids[index] ?? "";
}

/**
 * The role fields of every Case in one save, ids already assigned in the
 * same order, every scope resolved to a Case id and held to a Journey of
 * the list.
 */
export function normalizeCaseRoleFields(
  cases: readonly MutableSuiteCaseInput[],
  ids: readonly string[],
): CaseRoleFields[] {
  const roles = cases.map((suiteCase, index) => validateCaseRole(suiteCase.role, `cases[${index}].role`));
  const journeyIds = new Set(ids.filter((_id, index) => roles[index] === "journey"));
  return cases.map((suiteCase, index) => {
    const role = roles[index] ?? "journey";
    const field = `cases[${index}]`;
    if (suiteCase.scopeCaseId != null && suiteCase.scopeCandidateIndex != null) {
      throw new Error(`${field} must name its Journey by scopeCaseId or scopeCandidateIndex, not both.`);
    }
    const scopeField = suiteCase.scopeCandidateIndex != null ? `${field}.scopeCandidateIndex` : `${field}.scopeCaseId`;
    const scopeCaseId = suiteCase.scopeCandidateIndex != null
      ? scopeFromIndex(suiteCase.scopeCandidateIndex, ids, scopeField)
      : suiteCase.scopeCaseId ?? null;
    if (scopeCaseId !== null) {
      assertScopeAllowed(role, scopeField);
      if (scopeCaseId === ids[index] || !journeyIds.has(scopeCaseId)) {
        throw new Error(`${scopeField} must name a Journey of this Suite.`);
      }
    }
    const ownerConfirmation = suiteCase.ownerConfirmation === undefined
      ? undefined
      : validateOwnerConfirmation(suiteCase.ownerConfirmation, `${field}.ownerConfirmation`);
    return {
      role,
      scopeCaseId,
      repeat: validateRepeatForRole(role, suiteCase.repeat, `${field}.repeat`),
      ...(ownerConfirmation === undefined ? {} : { ownerConfirmation }),
    };
  });
}
