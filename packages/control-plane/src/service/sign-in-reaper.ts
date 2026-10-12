/**
 * Rows a verification leg walked away from.
 *
 * Settling a check is fire-and-forget: `settle` runs beside the request that
 * started it, so a host that restarts mid-check, or a store write that throws
 * after the leg has spoken, leaves the row saying `verifying` with nobody left
 * to change it. Nothing else ever revisits it — the page polls it forever and
 * the card spins forever, which is the worst kind of wrong, because it looks
 * like work is happening.
 *
 * So every place that reads a sign-in settles the ones no leg can still be
 * working on. Two things have to be true before a row counts as abandoned: it
 * has not been touched for longer than a leg may run, with a minute's grace for
 * a host that was busy; and no leg in this process is streaming for it. The
 * second is the one that matters while a check is genuinely slow.
 *
 * A leg that never reported proved nothing about the way in, so the verdict is
 * `failed` with the word for "we do not know" and the consecutive-failure count
 * is left exactly where it was. Three restarts are not three wrong passwords.
 */
import type { TeamSignIn } from "../store/team-sign-ins.ts";
import type { TenantActor } from "../types.ts";
import { SIGN_IN_VERIFY_STRANDED_AFTER_MS } from "./sign-in-timing.ts";

/** The one store door this needs; it writes a status and an audit row, nothing sealed. */
export interface StrandedSignInStore {
  reapStrandedSignIns(
    actor: TenantActor,
    teamId: string,
    input: { signInIds: readonly string[]; strandedBefore: Date },
  ): Promise<string[]>;
}

export interface SignInReapInput<T extends TeamSignIn = TeamSignIn> {
  actor: TenantActor;
  teamId: string;
  signIns: readonly T[];
  /** Whether a leg of this process is still streaming for the row. */
  hasLiveStream?: ((signInId: string) => boolean) | undefined;
  now?: number | undefined;
}

/** The rule itself: which of these rows no leg can still be working on. */
export function strandedSignInIds(input: SignInReapInput): string[] {
  const strandedBefore = (input.now ?? Date.now()) - SIGN_IN_VERIFY_STRANDED_AFTER_MS;
  return input.signIns
    .filter((signIn) => signIn.status === "verifying"
      && Date.parse(signIn.updatedAt) < strandedBefore
      && !input.hasLiveStream?.(signIn.id))
    .map((signIn) => signIn.id);
}

/**
 * Settles whatever of this list was abandoned, and answers the list as it now
 * stands. A row nobody settled is returned untouched, and a store that refuses
 * the write is not worth failing a read over: the list comes back as it was
 * read, and the next reader tries again.
 */
export async function reapStrandedSignIns<T extends TeamSignIn>(
  store: StrandedSignInStore,
  input: SignInReapInput<T>,
): Promise<T[]> {
  const stranded = strandedSignInIds(input);
  if (stranded.length === 0) return [...input.signIns];
  const strandedBefore = new Date((input.now ?? Date.now()) - SIGN_IN_VERIFY_STRANDED_AFTER_MS);
  const reaped = await store
    .reapStrandedSignIns(input.actor, input.teamId, { signInIds: stranded, strandedBefore })
    .catch((error: unknown): string[] => {
      console.error("[sign-ins] a stranded check could not be settled:", error);
      return [];
    });
  const settled = new Set(reaped);
  return input.signIns.map((signIn) => (settled.has(signIn.id)
    ? { ...signIn, status: "failed" as const, failureReason: "unknown" as const }
    : signIn));
}
