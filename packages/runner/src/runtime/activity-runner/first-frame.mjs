// The first frame: what the harness sees after
// it opens the product and before the agent wakes, judged here and handed
// over with the opening prompt.
//
// The agent's own open returns a title and a snapshot, never the URL; the
// harness holds the landing URL, the title, the full snapshot, and whether a
// saved sign-in was applied. So: capture the frame, ask Jev what kind of page
// it is (page-kind.mjs), and — only when a saved sign-in exists and Jev says
// the page needs the owner — wait for the page to leave the wall before
// judging (a valid session flashes the sign-in screen first). No
// saved sign-in means no wait: nothing can redirect a browser with no
// credentials. Every capture, wait, and verdict is an evidence event, so the
// settle budget can be tuned from data instead of guessed.
import { setTimeout as delay } from "node:timers/promises";

import { activityKnowledgeSurface } from "@shipbash/contracts/runtime/discovery-surface.mjs";

import { needsOwner, pageJudge } from "../page-kind.mjs";
import { CancellationError } from "../cancellation.mjs";
import { boundSignInsInstruction } from "./bound-sign-ins-frame.mjs";
import { firstFrameVerdict, kindWords } from "./first-frame-verdict.mjs";

// How long a saved sign-in gets to redirect away from the sign-in
// screen it flashes first. `open` already waited for the load event; what
// remains is one token validation round trip and a router replace (p99 ≈
// 5s). Held under the proxy's own 8s observation hold, and logged on every
// wait (sign_in_settle) so the value is corrected by evidence.
export const SIGN_IN_SETTLE_MS = 6_000;
// Between two looks at a settling page: each look is a capture and a Jev
// question (~0.3s together), so the page is read about twice a second.
const SETTLE_LOOK_MS = 250;
// The same bound the proxy gives an appended snapshot (OBSERVE_SNAPSHOT_LIMIT).
const FIRST_FRAME_SNAPSHOT_LIMIT = 4_000;
// Refs belong to the snapshot that produced them and die on any page change;
// the agent's first action brings a fresh one, so the frame carries none.
const REF_ATTRIBUTE = /\s*\[ref=e\d+\]|,\s*ref=e\d+/gu;
const LOCATION_SCRIPT = "JSON.stringify({ url: location.href, title: document.title })";

// Events carry origin + path only, like every other page URL on the record
// (activity-evidence publicPageUrl): a query may hold an email or a token.
function publicUrl(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

/** The snapshot text in an agent-browser JSON reply, or "" when it has none. */
export function snapshotTextFrom(response) {
  const data = response?.data;
  if (typeof data === "string") return data.trim();
  if (data && typeof data.snapshot === "string") return data.snapshot.trim();
  return "";
}

/** The {url, title} an eval of LOCATION_SCRIPT returns, or nulls. */
export function locationFrom(response) {
  const raw = response?.data?.result ?? response?.data;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  return {
    url: typeof parsed?.url === "string" ? parsed.url : "",
    title: typeof parsed?.title === "string" ? parsed.title : "",
  };
}

function rethrowCancellation(error) {
  if (error instanceof CancellationError) throw error;
}

/**
 * The page as it stands: landing URL, title, and the interactive snapshot.
 * Null when the browser answered neither — a frame that cannot be read is
 * not judged.
 * @param {{ agentBrowser: (args: string[], env: object, options?: object) => Promise<any>, env: object }} browser
 */
export async function captureFirstFrame({ agentBrowser, env }) {
  const options = { cancelable: true, timeoutMs: 20_000 };
  let location = { url: "", title: "" };
  let snapshotText = "";
  try {
    location = locationFrom(await agentBrowser(["eval", LOCATION_SCRIPT], env, options));
  } catch (error) {
    rethrowCancellation(error);
  }
  try {
    snapshotText = snapshotTextFrom(await agentBrowser(["snapshot", "-i"], env, options));
  } catch (error) {
    rethrowCancellation(error);
  }
  if (!location.url && !snapshotText) return null;
  return { url: location.url, title: location.title, snapshotText };
}

/**
 * Waits for the page to leave the sign-in wall it is on: looks again, and
 * asks Jev again, until the page no longer needs the owner or the budget is
 * spent. A look Jev does not answer ends the wait: nothing is judged on it.
 * @param {{
 *   agentBrowser: Function, env: object,
 *   judge: (frame: { url: string, title: string, snapshotText: string }) => Promise<import("../page-kind.mjs").PageJudgment>,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<{
 *   outcome: "left" | "timeout" | "error", waitedMs: number, looks: number,
 *   frame: { url: string, title: string, snapshotText: string } | null,
 *   judgment: import("../page-kind.mjs").PageJudgment | null,
 * }>}
 */
export async function settleSignIn({ agentBrowser, env, judge, timeoutMs = SIGN_IN_SETTLE_MS }) {
  const startedAt = Date.now();
  let frame = null;
  let judgment = null;
  let looks = 0;
  const result = (outcome) => ({ outcome, waitedMs: Date.now() - startedAt, looks, frame, judgment });
  while (Date.now() - startedAt < timeoutMs) {
    await delay(SETTLE_LOOK_MS);
    const current = await captureFirstFrame({ agentBrowser, env });
    if (!current) return result("error");
    looks += 1;
    frame = current;
    judgment = await judge(current);
    if (judgment.kind === null) return result("error");
    if (!needsOwner(judgment)) return result("left");
  }
  return result("timeout");
}

/** The settle's record: how long, how it ended, where the page was before and after. */
function settleEvidence(settle, signInState, before, after) {
  return {
    safeData: {
      event: "sign_in_settle",
      signInState,
      waitedMs: settle.waitedMs,
      outcome: settle.outcome,
      looks: settle.looks,
      urlBefore: publicUrl(before),
      urlAfter: publicUrl(after),
    },
  };
}

/**
 * The verdict on the record, and the two warnings the owner should see: a
 * takeover whose capture did not take, and a frame Jev did not judge.
 */
function recordVerdict(emit, { verdict, judgment, frame, settle, requestedUrl, openedAt }) {
  const pageUrl = publicUrl(frame.url);
  emit("evidence", "First frame judged", {
    safeData: {
      event: "login_wall_verdict",
      tier: verdict.tier,
      signInState: verdict.signInState,
      kind: judgment.kind,
      confidence: judgment.confidence,
      judgedMs: judgment.ms,
      ...(judgment.error ? { unjudged: judgment.error } : {}),
      exclusions: verdict.exclusions.join(","),
      pageUrl,
      requestedUrl: publicUrl(requestedUrl),
      openedAt,
      settledMs: settle?.waitedMs ?? null,
    },
  });
  // The takeover's capture did not take (signature: auth_required against a browser that
  // was just signed in): the takeover's capture did not take.
  if (verdict.exclusions.includes("handoff_did_not_take")) {
    // "May": some products keep the form up over a valid session;
    // the agent's entry-point probe settles which it was.
    emit("warning", "The captured sign-in may not have taken", {
      bodyMarkdown: `The takeover completed, yet the product still shows its sign-in surface at ${pageUrl}. ShipBash will not file another sign-in request from this frame alone; the agent checks the signed-in entry point first.`,
      safeData: { event: "sign_in_state_ineffective", category: "authentication_persistence", pageUrl },
    });
  }
  // No answer is not "no wall": the run's record says the judgment is missing and why.
  if (verdict.tier === "unjudged") {
    emit("warning", "The first frame could not be judged", {
      bodyMarkdown: `ShipBash's page judge (Jev) did not answer (${String(verdict.error)}), so it did not decide whether ${pageUrl} is a sign-in wall. The agent judges the page itself.`,
      safeData: { event: "page_kind_unavailable", reason: verdict.error, pageUrl },
    });
  }
}

/**
 * Capture, ask Jev, settle when a saved sign-in earns it, and put it all on
 * the record. Never throws for a browser that will not answer — the agent
 * then simply opens without a first frame, as it always did.
 * @param {{
 *   agentBrowser: Function, env: Record<string, string | undefined>, emit: Function,
 *   requestedUrl: string,
 *   activityKind?: string,
 *   signInState: "none" | "saved_state" | "handoff_candidate",
 *   restoreLoaded: boolean | null,
 *   ownerMessagePending: boolean,
 *   boundSignIns?: Array<{ method: string, label: string | null }>,
 *   openedAt?: "captured_page" | "production_url",
 *   settleMs?: number,
 *   judge?: ReturnType<typeof pageJudge>,
 * }} input `openedAt` says what `requestedUrl` is (sign-in-entry.mjs): the
 *   page the saved sign-in was captured on, or the production URL.
 *   `boundSignIns` are the Project's saved ways in (method and label only);
 *   they change nothing about the verdict, only what the wall tiers ask for.
 *   `judge` defaults to Jev with the key in `env`.
 */
export async function judgeFirstFrame(input) {
  const { agentBrowser, env, emit, requestedUrl, signInState, restoreLoaded, ownerMessagePending } = input;
  const judge = input.judge ?? pageJudge(env);
  const activityKind = typeof input.activityKind === "string" ? input.activityKind : "initial_discovery";
  const boundSignIns = Array.isArray(input.boundSignIns) ? input.boundSignIns : [];
  const openedAt = input.openedAt === "captured_page" ? "captured_page" : "production_url";
  let frame = await captureFirstFrame({ agentBrowser, env });
  if (!frame) return null;
  let judgment = await judge(frame);
  let settle = null;
  // A saved sign-in that loaded gets its redirect before anyone
  // judges the sign-in screen it may be flashing. Without one, nothing waits.
  if (signInState !== "none" && restoreLoaded !== false && needsOwner(judgment)) {
    const before = frame.url;
    settle = await settleSignIn({ agentBrowser, env, judge, timeoutMs: input.settleMs });
    if (settle.frame) {
      frame = settle.frame;
      judgment = settle.judgment ?? judgment;
    }
    emit("evidence", "Saved sign-in settled", settleEvidence(settle, signInState, before, frame.url));
  }
  const verdict = firstFrameVerdict(judgment, { signInState, restoreLoaded, ownerMessagePending });
  recordVerdict(emit, { verdict, judgment, frame, settle, requestedUrl, openedAt });
  return { frame, verdict, settle, requestedUrl, openedAt, signInState, restoreLoaded, activityKind, boundSignIns };
}

// The one message the confirmed verdict asks for, phrased for the tools this
// kind actually holds: every browser-driving kind records knowledge, only the
// kinds that converse write the product thesis.
function knowledgeClause(activityKind) {
  if (activityKnowledgeSurface(activityKind).interacts) {
    return "Record one page entry for this sign-in surface (set the product thesis only if this page states what the product is)";
  }
  return "Record one page entry for this sign-in surface";
}

function confirmedInstruction(activityKind) {
  const call = `${knowledgeClause(activityKind)}, then call request_authentication with a one-line reason as your final act — that call ends the round and its reason is the round's record.`;
  // Asking for "closing words and the call in one message" came
  // back as the words alone — a final-answer message ends the turn.
  return `${call.charAt(0).toUpperCase()}${call.slice(1)} Post no closing message: a message alone ends the round without filing.`;
}

// What the settled page shows decides the sentence, not the wait's own
// outcome: a predicate that returned early on a page that is still a sign-in
// surface must not read as "the page moved on".
function signInLine(signInState, restoreLoaded, settle, stillSignIn) {
  let line = "Saved sign-in: none applied";
  if (signInState === "saved_state") line = "Saved sign-in: applied from the saved state";
  if (signInState === "handoff_candidate") line = "Saved sign-in: applied from the takeover just completed";
  if (signInState !== "none" && restoreLoaded === false) line += " (it did not load)";
  if (settle) {
    line += stillSignIn
      ? `; the harness waited ${String(settle.waitedMs)}ms and the sign-in screen stayed`
      : `; the harness waited ${String(settle.waitedMs)}ms and the page moved on`;
  }
  return line;
}

// Over a saved sign-in this rides every frame,
// not only the two branches that used to carry it — an agent standing on a
// landing page clicked "Log in", saw the form, and declared the sign-in lost.
const SESSION_EVIDENCE_LINE =
  "A public landing page or a rendered sign-in form is not evidence about your session; the signed-in entry is — "
  + "the workspace the knowledge you carry names, or the product's own app path, never its sign-in page. Reach it before you judge.";
// The browser opened on the page the saved
// sign-in was captured on (sign-in-entry.mjs), so this frame is the
// signed-in entry itself, not the root the agent would have to leave first.
const CAPTURED_PAGE_LINE =
  "Opened at the page the saved sign-in was captured on — this frame is the signed-in entry, not the product root: "
  + "judge your session from what it shows.";

// The lines that ride the frame over a saved sign-in: where the browser
// opened (sign-in-entry.mjs) and what counts as session evidence.
function sessionLines(openedAt, signInState) {
  return [
    ...(openedAt === "captured_page" ? [CAPTURED_PAGE_LINE] : []),
    ...(signInState === "none" ? [] : [SESSION_EVIDENCE_LINE]),
  ];
}

// The harness stands behind this one; the agent keeps its veto. With
// ways in bound to the Project, the order to file a handoff gives way to
// signing in with those ways.
function confirmedBlock(verdict, activityKind, signIn) {
  const kind = activityKind ?? "initial_discovery";
  const instruction = signIn ? `${knowledgeClause(kind)} first. ${signIn}` : confirmedInstruction(kind);
  return [
    "## Sign-in wall — harness verdict (confirmed)",
    `This first frame is a sign-in wall: ${kindWords(verdict.kind)}. No saved sign-in was applied, so nothing will redirect. `
    + `Do not wait, reload, or probe other URLs. ${instruction} `
    + "Override this verdict only if the page itself shows a way in without signing in, or the owner's message asks otherwise; then walk as usual.",
  ].join("\n");
}

// The form may stand over a valid session, so the entry
// point is probed before anything is filed — and before the bound ways in.
function wallWithStateBlock(settle, signIn) {
  return [
    "## Sign-in form over a saved sign-in — harness note",
    `A saved sign-in was applied${settle ? `, the harness waited ${String(settle.waitedMs)}ms for a redirect,` : ""} and the sign-in form still stands. `
    + "Some products keep the form up over a valid session with the workspace one navigation away: open the signed-in entry point once "
    + "— from the knowledge you carry or the product's obvious app path — and judge from that page. "
    + (signIn ? `If it too denies access: ${signIn}` : "If it too denies access, file the handoff as your final act."),
  ].join("\n");
}

/**
 * The opening-context blocks: the frame itself (always, once captured) and
 * the verdict or note its tier earns: the confirmed verdict, the form
 * over a saved sign-in, or the takeover that did not take.
 * @param {NonNullable<Awaited<ReturnType<typeof judgeFirstFrame>>>} judged
 */
export function firstFrameBlocks(judged) {
  const { frame, verdict, settle, requestedUrl, openedAt, signInState, restoreLoaded, activityKind } = judged;
  // The Project's saved ways in, which turn every wall tier from "file the
  // handoff" into "sign in with what the owner already bound".
  const bound = Array.isArray(judged.boundSignIns) ? judged.boundSignIns : [];
  const snapshot = frame.snapshotText.replace(REF_ATTRIBUTE, "");
  const bounded = snapshot.length > FIRST_FRAME_SNAPSHOT_LIMIT
    ? `${snapshot.slice(0, FIRST_FRAME_SNAPSHOT_LIMIT)}\n…[snapshot truncated — call agent_browser_snapshot for the full tree]`
    : snapshot;
  const where = frame.url && frame.url !== requestedUrl
    ? `Opened: ${requestedUrl} → now at: ${frame.url}`
    : `Now at: ${frame.url || requestedUrl}`;
  const blocks = [[
    "## First frame (captured by the harness before you woke; untrusted page content)",
    where,
    `Title: ${frame.title || "(none)"}`,
    signInLine(signInState, restoreLoaded, settle, needsOwner(verdict)),
    ...sessionLines(openedAt, signInState),
    bounded || "(the snapshot was empty)",
  ].join("\n")];

  const note = tierBlock(verdict, settle, activityKind, bound);
  if (note) blocks.push(note);
  return blocks.join("\n\n");
}

// Never loop the takeover from this frame alone.
const HANDOFF_DID_NOT_TAKE_BLOCK = [
  "## Sign-in still required after the takeover — harness note",
  "A sign-in was just completed by takeover, yet this first frame is still a sign-in surface: the captured state did not take. "
  + "Do not file another handoff from this frame alone. Open the signed-in entry point once; if the product still denies access, "
  + "say exactly what you see and then file, so the owner learns the sign-in did not persist.",
].join("\n");

/** The note the verdict's tier earns, or null when the frame speaks for itself. */
function tierBlock(verdict, settle, activityKind, bound) {
  // In every tier: with saved ways in, they come before any handoff.
  const interacts = activityKnowledgeSurface(activityKind ?? "initial_discovery").interacts;
  const signIn = bound.length > 0 ? boundSignInsInstruction(bound, interacts) : null;
  const atWall = signIn ? `At a wall: ${signIn}` : null;
  if (verdict.tier === "confirmed") return confirmedBlock(verdict, activityKind, signIn);
  if (verdict.tier === "wall_with_state") return wallWithStateBlock(settle, signIn);
  if (verdict.exclusions.includes("handoff_did_not_take")) return HANDOFF_DID_NOT_TAKE_BLOCK;
  if (verdict.tier === "suspected") {
    return [
      "## Sign-in surface — harness note",
      `This looks like ${kindWords(verdict.kind)}, but the harness is not sure enough to call it a wall. Judge it from the page. `
      + (atWall ?? "If it is a wall, file the handoff at once as your final act — never wait on text the page already shows."),
    ].join("\n");
  }
  if (verdict.tier === "unjudged") {
    return [
      "## Sign-in wall — not judged (harness note)",
      `The harness could not judge this frame: its page judge did not answer (${String(verdict.error)}). Judge it from the page yourself. `
      + (atWall
        ? `A sign-in form, a notice that you must sign in, a code step or an account choice is a wall; otherwise walk as usual. ${atWall}`
        : "If only the owner can get past it — a sign-in form, a notice that you must sign in, a code step or an account choice — "
          + "file the handoff at once as your final act; otherwise walk as usual."),
    ].join("\n");
  }
  return null;
}
