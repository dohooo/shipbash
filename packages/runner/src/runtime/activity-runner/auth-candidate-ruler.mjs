// The sign-in ruler for the Activity lane's inline takeover: the third
// producer of candidate.ready, judged by the same function as the takeover
// viewer's capture (contracts/runtime/sign-in-scope.mjs). Here the agent's
// own browser was handed over, so the product page is read the way the
// first frame is — an agent-browser snapshot, judged by Jev (page-kind.mjs) —
// and the state is the document results.mjs captured over the browser's CDP
// endpoint.
import { hostOf, publicPageUrl, readSignInScope, registrableDomain } from "@shipbash/contracts/runtime/sign-in-scope.mjs";

import { judgmentSignal, needsOwner, pageJudge } from "../page-kind.mjs";

/**
 * The agent browser's page as the ruler's judge: on the product's site, a
 * sign-in surface is a page Jev's top answer says only the owner can get
 * past, however sure it is — a doubt costs the person one more sign-in, the
 * other side seals a state that signs nobody in. A page Jev did not judge is
 * no verdict: its host is reported unanswered.
 *
 * @returns {Promise<{ page: { url: string, signInSurface: boolean, signals: string[] } | null, unjudged: string[] }>}
 */
async function inlinePageVerdict(io, env, productionUrl) {
  const frame = await io.captureFirstFrame({ agentBrowser: io.agentBrowser, env }).catch(() => null);
  if (!frame?.url || registrableDomain(hostOf(frame.url)) !== registrableDomain(hostOf(productionUrl))) {
    return { page: null, unjudged: [] };
  }
  const judgment = await (io.judge ?? pageJudge(env))(frame);
  if (judgment.kind === null) return { page: null, unjudged: [hostOf(frame.url)] };
  return {
    page: { url: publicPageUrl(frame.url), signInSurface: needsOwner(judgment), signals: [judgmentSignal(judgment)] },
    unjudged: [],
  };
}

/**
 * The scope of the inline candidate, on the shared ruler.
 *
 * @param {{ agentBrowser: Function, captureFirstFrame: Function, judge?: ReturnType<typeof pageJudge> }} io
 *   `judge` defaults to Jev with the key in `env`.
 * @param {Record<string, string | undefined>} env The agent-browser environment.
 * @param {string} productionUrl The product URL the Activity opened on.
 * @param {unknown} state The ShipBash state document captured from the agent's browser.
 * @param {string[]} [unanswered] The hosts of the pages that did not answer the capture in time.
 */
export async function judgeInlineCandidate(io, env, productionUrl, state, unanswered = []) {
  const { page, unjudged } = await inlinePageVerdict(io, env, productionUrl);
  return { ...readSignInScope(state, productionUrl, page, null, [...unanswered, ...unjudged]), lane: "activity_inline" };
}
