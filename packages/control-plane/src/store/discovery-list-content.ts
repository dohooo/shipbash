/**
 * Whether a round delivers the very list a conversation's Proposal already
 * holds. A Journey drafted in the conversation travels without an id and is
 * given a fresh one at every delivery, so an id is compared as itself only
 * where both lists carry it — the Suite's own Cases — and a fresh one stands
 * for its place in its own list, wherever it is named: as a Case's id or as
 * the Journey a hook is scoped to.
 */
import { isDeepStrictEqual } from "node:util";

import { isRecord } from "../is-record.ts";

function idsOf(list: readonly unknown[]): Set<string> {
  return new Set(list.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [])));
}

function canonical(list: readonly unknown[], shared: ReadonlySet<string>): unknown[] {
  const place = new Map(list.flatMap((entry, index): Array<[string, number]> =>
    (isRecord(entry) && typeof entry.id === "string" ? [[entry.id, index]] : [])));
  const stand = (id: unknown) => {
    const index = typeof id === "string" && !shared.has(id) ? place.get(id) : undefined;
    return index === undefined ? id : `#${String(index)}`;
  };
  return list.map((entry) => (isRecord(entry) ? { ...entry, id: stand(entry.id), scopeCaseId: stand(entry.scopeCaseId) } : entry));
}

export function sameCandidateList(held: unknown, delivered: unknown): boolean {
  if (!Array.isArray(held) || !Array.isArray(delivered) || held.length !== delivered.length) return false;
  const deliveredIds = idsOf(delivered);
  const shared = new Set([...idsOf(held)].filter((id) => deliveredIds.has(id)));
  return isDeepStrictEqual(canonical(held, shared), canonical(delivered, shared));
}
