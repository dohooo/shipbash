/**
 * Every message ShipBash posts into a customer's channel, in four templates.
 *
 *   ① The connection message, once, when a project is bound to the channel.
 *   ② The run result, in the channel: a run that failed, or one that could
 *      not verify anything. It opens the thread everything later goes into.
 *   ③ A thread reply: one line naming one journey (or the blocker), optional
 *      bullets, and a "View details" button onto that journey in this run.
 *      Each failed journey's reply carries its recording; the caller uploads
 *      it with these blocks.
 *   ④ Hand off to agent: the evidence command, posted as the next message
 *      under every screen recording ShipBash shares — an alert's or a
 *      conversation's — since Slack draws a file below its own message's
 *      blocks, never under them.
 *
 * ② failed carries no video and no button. Its run URL is the linked suite
 * name, and it is posted with `unfurl_links`, so Slack's own preview draws the
 * run's card under it. No reply puts a URL in its text or rich text, because
 * a text URL is what Slack unfurls; a URL button is not. Delivery puts the
 * Delete row at the foot of every one of them (slack-delete-row.ts).
 */
import { evidenceCommand } from "@shipbash/contracts/runtime/evidence-command.mjs";

import { type ConsoleLinks, journeyUrl, runUrl, scopedUrl } from "./console-links.ts";
import {
  type ActionsBlock,
  type RichTextBlock,
  type RichTextElement,
  type SlackMessagePayload,
  type SlackStatus,
  actions,
  bullets,
  context,
  cut,
  emoji,
  header,
  localTime,
  mrkdwn,
  plural,
  quoted,
  section,
  statusChar,
  text,
} from "./slack-block-kit.ts";
import type { SlackAlertBlocker, SlackAlertJourney, SlackAlertView } from "./slack-alert-view.ts";

export type { SlackBlock, SlackMessagePayload } from "./slack-block-kit.ts";

/** Budgets for customer-controlled strings, so a long one cannot crowd out the facts. */
const TITLE_LIMIT = 150;
const GOAL_LIMIT = 120;
const REASON_LIMIT = 300;
const SUITE_LIMIT = 120;
/** Slack's ceiling on a button's accessibility label. */
const BUTTON_LABEL_LIMIT = 75;

const CAUSE: Record<SlackAlertBlocker, string> = {
  sign_in_required: "Sign-in needed",
  blocked: "Blocked",
  infrastructure_error: "ShipBash infrastructure error",
};

/** The same causes mid-sentence, after "Still couldn't verify — ". */
const CAUSE_IN_SENTENCE: Record<SlackAlertBlocker, string> = {
  sign_in_required: "sign-in needed",
  blocked: "blocked",
  infrastructure_error: "ShipBash infrastructure error",
};

/** The journey a reply names, and the walk of it in this run the button opens. */
export interface SlackReplyJourney {
  title: string;
  /** Null only for a journey this run never walked, which then opens the run. */
  caseRunId: string | null;
}

/** A still-red journey's reply: whether it broke where it broke last time. */
export interface SlackStillFailingJourney extends SlackReplyJourney {
  sameCheckpoint: boolean;
  /** Where it stops now, when the step moved. */
  stoppedAtGoal: string | null;
}

interface ReplyInput<Journey> {
  journey: Journey;
  runId: string;
  links: ConsoleLinks;
}

/** How the run started, and when, in each reader's own clock. */
function runLine(view: SlackAlertView): string {
  return `${view.trigger === "scheduled" ? "Scheduled" : "Manual"} ${localTime(view.triggeredAt)}`;
}

/**
 * The one button a journey reply has. The reply names one journey, so the
 * label can simply say what it opens; a screen reader hears which journey.
 */
function viewDetails(input: ReplyInput<SlackReplyJourney>): ActionsBlock {
  const { journey, runId, links } = input;
  return actions({
    type: "button",
    text: { type: "plain_text", text: "View details" },
    url: journey.caseRunId === null ? runUrl(links, runId) : journeyUrl(links, runId, journey.caseRunId),
    action_id: "view_details",
    accessibility_label: cut(`View details of ${journey.title}`, BUTTON_LABEL_LIMIT),
  });
}

/** The one reply shape: `<emoji> *State* — subject`, then optional bullets. */
function reply(
  status: SlackStatus,
  state: string,
  subject: readonly RichTextElement[],
  list: readonly RichTextElement[][] = [],
): RichTextBlock {
  const lead = section(emoji(status), text(" "), text(state, { bold: true }), text(" — "), ...subject);
  return { type: "rich_text", elements: list.length > 0 ? [lead, bullets(list)] : [lead] };
}

/** ① Posted once, when the project is bound to this channel. */
export function connectionMessage(input: { projectName: string; sentBy: string }): SlackMessagePayload {
  const project = cut(input.projectName, TITLE_LIMIT);
  return {
    text: `${statusChar("connected")} ${mrkdwn(project)} is connected to this channel`,
    blocks: [
      {
        type: "rich_text",
        elements: [section(
          emoji("connected"),
          text(" "),
          quoted(project, { bold: true }),
          text(" is connected to this channel"),
        )],
      },
      context(`Set up by ${mrkdwn(cut(input.sentBy, TITLE_LIMIT))}`),
    ],
  };
}

/**
 * ② failed: every journey this message opens a thread for, by name. The
 * header counts every journey of the run that failed; the ones whose thread
 * an earlier run already opened are counted there and said to be "already
 * reported", and each gets its reply in its own thread instead.
 */
export function runResultFailed(input: {
  view: SlackAlertView;
  listed: readonly SlackAlertJourney[];
  alreadyReported: number;
  links: ConsoleLinks;
}): SlackMessagePayload {
  const { view, listed, alreadyReported } = input;
  const failed = listed.length + alreadyReported;
  const summary = `${String(failed)} of ${plural(view.journeys.length, "journey")} failed`;
  const url = runUrl(input.links, view.runId);
  const names = listed.map((journey) => mrkdwn(cut(journey.title, TITLE_LIMIT))).join(", ");
  const reported = alreadyReported > 0 ? [`${String(alreadyReported)} already reported`] : [];
  const suite = mrkdwn(cut(view.suiteName, SUITE_LIMIT));
  return {
    text: [
      `${statusChar("failed")} ${mrkdwn(cut(view.projectName, TITLE_LIMIT))}: ${summary} — ${names}`,
      ...reported,
      `<${url}|View run>`,
    ].join(" · "),
    unfurl_links: true,
    unfurl_media: true,
    blocks: [
      header("failed", view.projectName, summary),
      context([`<${url}|${suite}>`, runLine(view), "Recordings in the thread", ...reported].join("  ·  ")),
      {
        type: "rich_text",
        elements: [bullets(listed.map((journey) => [quoted(cut(journey.title, TITLE_LIMIT))]))],
      },
    ],
  };
}

/**
 * What stopped the run, as rich text: the cause, then the account a sign-in
 * is owed for or the detail a walk observed. `asLead` bolds the cause for the
 * run result; a follow-up reads it mid-sentence.
 */
function causeElements(view: SlackAlertView, blocker: SlackAlertBlocker, asLead: boolean): RichTextElement[] {
  const cause = asLead ? text(CAUSE[blocker], { bold: true }) : text(CAUSE_IN_SENTENCE[blocker]);
  if (view.signInAccount !== null) {
    return [cause, text(" for "), quoted(`@${cut(view.signInAccount, TITLE_LIMIT)}`, { code: true })];
  }
  if (view.blockerDetail !== null) return [cause, text("  ·  "), quoted(cut(view.blockerDetail, REASON_LIMIT))];
  return [cause];
}

/** The cause as the notification line says it. */
function causeSentence(view: SlackAlertView, cause: string): string {
  return view.signInAccount === null ? cause : `${cause} for @${mrkdwn(cut(view.signInAccount, TITLE_LIMIT))}`;
}

/**
 * ② couldn't verify: yellow, never red, and it says it is not a product
 * failure. There is no run link to unfurl — a blocked run has no card — so its
 * one button goes where the cause is fixed.
 */
export function runResultCouldNotVerify(input: {
  view: SlackAlertView;
  blocker: SlackAlertBlocker;
  links: ConsoleLinks;
}): SlackMessagePayload {
  const { view, blocker, links } = input;
  const skipped = plural(view.skippedJourneys, "journey");
  const target = blocker === "sign_in_required"
    ? { label: "Fix sign-in", url: scopedUrl(links, "settings/sign-ins"), actionId: "fix_sign_in" }
    : { label: "View details", url: runUrl(links, view.runId), actionId: "view_details" };
  const project = mrkdwn(cut(view.projectName, TITLE_LIMIT));
  return {
    text: `${statusChar("unverified")} ${project}: couldn't verify — ${causeSentence(view, CAUSE[blocker])}. ${skipped} skipped. Not a product failure.`,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      header("unverified", view.projectName, "Couldn't verify"),
      context([mrkdwn(cut(view.suiteName, SUITE_LIMIT)), runLine(view), "Not a product failure"].join("  ·  ")),
      {
        type: "rich_text",
        elements: [bullets([[...causeElements(view, blocker, true), text(`  ·  ${skipped} skipped`)]])],
      },
      actions({
        type: "button",
        style: "primary",
        text: { type: "plain_text", text: target.label },
        url: target.url,
        action_id: target.actionId,
      }),
    ],
  };
}

/** ③ Failed: posted under ② for each journey it lists, with that journey's recording. */
export function replyFailedJourney(input: ReplyInput<SlackAlertJourney>): SlackMessagePayload {
  const { journey } = input;
  const title = cut(journey.title, TITLE_LIMIT);
  const goal = journey.stoppedAtGoal === null ? null : cut(journey.stoppedAtGoal, GOAL_LIMIT);
  const list: RichTextElement[][] = [];
  if (goal !== null) list.push([text("Stopped at "), quoted(goal, { italic: true })]);
  if (journey.reason !== null) list.push([text("Saw: "), quoted(cut(journey.reason, REASON_LIMIT))]);
  const stopped = goal === null ? "" : ` — stopped at “${mrkdwn(goal)}”`;
  return {
    text: `${statusChar("failed")} Failed — ${mrkdwn(title)}${stopped}`,
    blocks: [reply("failed", "Failed", [quoted(title, { bold: true })], list), viewDetails(input)],
  };
}

/** ③ Still failing: one per journey, in that journey's own thread. */
export function replyStillFailing(input: ReplyInput<SlackStillFailingJourney>): SlackMessagePayload {
  const { journey } = input;
  const title = cut(journey.title, TITLE_LIMIT);
  const where = journey.sameCheckpoint
    ? [text("  ·  same step")]
    : [
        text("  ·  now stops at "),
        quoted(cut(journey.stoppedAtGoal ?? "a different step", GOAL_LIMIT), { italic: true }),
      ];
  return {
    text: `${statusChar("failed")} Still failing — ${mrkdwn(title)}${journey.sameCheckpoint ? " (same step)" : ""}`,
    blocks: [reply("failed", "Still failing", [quoted(title), ...where]), viewDetails(input)],
  };
}

/** How long the journey was red, in the coarsest unit that is still true. */
function timeRed(openedAt: string, passedAt: string): string {
  const minutes = Math.max(1, Math.round((Date.parse(passedAt) - Date.parse(openedAt)) / 60_000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours < 48 ? plural(hours, "hour") : plural(Math.round(hours / 24), "day");
}

/** ③ Recovered: the one reply the poster also broadcasts to the channel. */
export function replyRecovered(
  input: ReplyInput<SlackReplyJourney> & { openedAt: string; passedAt: string },
): SlackMessagePayload {
  const title = cut(input.journey.title, TITLE_LIMIT);
  const red = `red for ${timeRed(input.openedAt, input.passedAt)}`;
  return {
    text: `${statusChar("recovered")} Recovered — ${mrkdwn(title)} (${red})`,
    blocks: [reply("recovered", "Recovered", [quoted(title), text(`  ·  ${red}`)]), viewDetails(input)],
  };
}

/** ③ Still couldn't verify: names no journey — the blocker stopped them all — so no button. */
export function replyStillCouldNotVerify(input: {
  view: SlackAlertView;
  blocker: SlackAlertBlocker;
}): SlackMessagePayload {
  const { view, blocker } = input;
  return {
    text: `${statusChar("unverified")} Still couldn't verify — ${causeSentence(view, CAUSE_IN_SENTENCE[blocker])}`,
    blocks: [reply("unverified", "Still couldn't verify", causeElements(view, blocker, false))],
  };
}

/**
 * ④ Under a screen recording: the command that pulls what the walk it shows
 * left — a Journey's case run id, or a walk's Activity id — for the owner's
 * coding agent, in a code block of its own under a small title.
 */
export function replyHandoff(id: string): SlackMessagePayload {
  const command = evidenceCommand(id);
  return {
    text: `Hand off to agent: ${command}`,
    blocks: [
      context("Hand off to agent:"),
      { type: "rich_text", elements: [{ type: "rich_text_preformatted", elements: [text(command)] }] },
    ],
  };
}
