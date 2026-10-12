import type { PublicVerification } from "@shipbash/contracts/api/public-verifications";
import { type RunCardFacts, runCardFacts } from "@shipbash/contracts/run-card";

/**
 * The two states the card draws. Which runs get a card at all is
 * `runCardFacts`'s to decide, for the shared page and a private run's address
 * alike.
 */
export type ShareCardTone = RunCardFacts["outcome"];

export interface ShareCard {
  tone: ShareCardTone;
  /** The subject: failures in the failed state, the suite size in the passed state. */
  figure: string;
  /** The journey total, drawn at half the figure's size. */
  denominator: string;
  /** Steps down as the FIGURE gains digits, so the denominator can carry any suite size without the line rewrapping. */
  figureSize: number;
  headline: string;
  subline: string;
  /** `Project · Suite`, which the card ellipsizes when a name is long. */
  footerName: string;
  /** The run's UTC stamp, which the card never ellipsizes: these images are cached and re-shared, and a verdict with no day describes no particular day. */
  footerStamp: string;
}

function figureSize(figure: number): number {
  const digits = String(figure).length;
  if (digits <= 2) return 148;
  if (digits === 3) return 126;
  return 112;
}

/** Agreement follows the figure, not the total: `1/148 journey failed`. */
function journeyNoun(count: number): string {
  return count === 1 ? "journey" : "journeys";
}

/**
 * Past two failures the names collapse. Listing them is noise at unfurl size,
 * and the card is not where a failure list gets read.
 */
function failedNames({ failed, failedTitles }: RunCardFacts): string {
  const rest = failed - failedTitles.length;
  if (rest > 0) return `${failedTitles.join(", ")} and ${String(rest)} more`;
  return failedTitles.join(" and ");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `Jan 1, 12:00 UTC`, carrying the year only when the run is not from this
 * one. These images are cached and re-shared, and a verdict with no day
 * misrepresents a production system three weeks later.
 */
function utcStamp(iso: string, now: Date): string {
  const at = new Date(iso);
  const year = at.getUTCFullYear() === now.getUTCFullYear() ? "" : `, ${String(at.getUTCFullYear())}`;
  const day = `${MONTHS[at.getUTCMonth()] ?? ""} ${String(at.getUTCDate())}`;
  return `${day}${year}, ${at.toISOString().slice(11, 16)} UTC`;
}

type Footer = Pick<ShareCard, "footerName" | "footerStamp">;

function failedCard(facts: RunCardFacts, footer: Footer): ShareCard {
  return {
    tone: "failed",
    figure: String(facts.failed),
    denominator: String(facts.total),
    figureSize: figureSize(facts.failed),
    headline: `${journeyNoun(facts.failed)} failed`,
    subline: failedNames(facts),
    ...footer,
  };
}

function passedCard(total: number, footer: Footer): ShareCard {
  return {
    tone: "passed",
    figure: String(total),
    denominator: String(total),
    figureSize: figureSize(total),
    headline: `${journeyNoun(total)} passed`,
    subline: "Every guarded journey held",
    ...footer,
  };
}

/**
 * The card a run's facts draw. `now` decides whether the footer needs a year,
 * and is passed in rather than read from the clock so the card stays a
 * function of its arguments.
 */
export function cardFromFacts(facts: RunCardFacts, now: Date): ShareCard {
  const footer: Footer = {
    footerName: `${facts.projectName} · ${facts.suiteLabel}`,
    footerStamp: utcStamp(facts.completedAt, now),
  };
  return facts.outcome === "failed" ? failedCard(facts, footer) : passedCard(facts.total, footer);
}

/** The shared verification payload as the card reads it, or null when no honest card exists for this run. */
export function shareCard(run: PublicVerification, now: Date): ShareCard | null {
  const facts = runCardFacts(run);
  return facts && cardFromFacts(facts, now);
}
