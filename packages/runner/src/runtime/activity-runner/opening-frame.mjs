// The first frame's place in the Activity arc:
// judged after the stream is up, so the owner watches the page while a saved
// sign-in gets its redirect, and before the agent wakes, so the verdict rides
// its opening context. Wires the pure judgment (first-frame.mjs) to this
// runner's browser, events, control root, and sign-in state — and arms the
// entry check (entry-check.mjs): "open the entry once before
// judging" enforced at the round-ending tools instead of asked for in prose.
import { createEntryCheck, knownEntriesFrom } from "../entry-check.mjs";
import { harnessPathsUnder, peekPendingSteers, readPageIndex } from "../harness-notes.mjs";
import { agentBrowser, signInStateRestore } from "./browser.mjs";
import { CONTROL_ROOT } from "./environment.mjs";
import { firstFrameBlocks, judgeFirstFrame } from "./first-frame.mjs";
import { CancellationError, emit } from "./state.mjs";

/**
 * The opening-context blocks for this leg — null when the browser would not
 * answer, then the agent opens as it always did — and the leg's entry check.
 * @param {{
 *   activity: { productionUrl: string, kind: string, boundSignIns?: Array<{ method: string, label: string | null }> },
 *   env: Record<string, string | undefined>,
 *   authStatePath: string | null,
 *   signInStateSource: "saved_state" | "handoff_candidate" | null,
 *   entry: { url: string, source: "captured_page" | "production_url" },
 *   pagesSeen: () => Promise<string[]>,
 * }} leg `entry` is where the browser opened (sign-in-entry.mjs): the page
 *   the saved sign-in was captured on, or the production URL.
 * @returns {Promise<{ firstFrameContext: string | null, wallConfirmed: boolean, entryCheck: ReturnType<typeof createEntryCheck> }>}
 *   `wallConfirmed` is the harness's own verdict (first-frame-verdict.mjs), for the
 *   words-only close rule (pi-round-continuation.mjs).
 */
export async function openingFrameContext({ activity, env, authStatePath, signInStateSource, entry, pagesSeen }) {
  const restore = authStatePath === null ? null : signInStateRestore();
  // With a sign-in state loaded, a conclusion drawn from the
  // doorstep alone is sent back once with the entry to open. A state that
  // did not load is a harness fault, not a session for a form to stand over.
  const entryCheck = createEntryCheck({
    signInLoaded: authStatePath !== null && restore?.loaded !== false,
    productionUrl: activity.productionUrl,
    pagesSeen,
    knownEntries: () => knownEntriesFrom(readPageIndex(harnessPathsUnder(CONTROL_ROOT).pageIndexPath), activity.productionUrl),
  });
  const judged = await judgeFirstFrame({
    agentBrowser,
    env,
    emit,
    requestedUrl: entry.url,
    openedAt: entry.source,
    activityKind: activity.kind,
    signInState: signInStateSource ?? "none",
    restoreLoaded: restore ? restore.loaded : null,
    // The ways in the owner already bound to this Project reach the wall
    // verdict, not the task prompt alone — the verdict is the later and more
    // imperative message, and it must not order a handoff over their heads.
    boundSignIns: Array.isArray(activity.boundSignIns) ? activity.boundSignIns : [],
    ownerMessagePending: peekPendingSteers(harnessPathsUnder(CONTROL_ROOT).steerDirectory).length > 0,
  }).catch((error) => {
    if (error instanceof CancellationError) throw error;
    return null;
  });
  return { firstFrameContext: judged ? firstFrameBlocks(judged) : null, wallConfirmed: judged?.verdict.tier === "confirmed", entryCheck };
}
