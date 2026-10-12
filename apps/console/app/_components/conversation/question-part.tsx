"use client";

import { ChevronRight, MessageSquare } from "lucide-react";
import { useState } from "react";

import { answerValue, type QuestionPart as Question } from "../../_lib/conversation-parts";

/**
 * A question is a tool group: a settled exchange is history, exactly like a
 * browser call, so it reuses the group skeleton unchanged — chevron, 13px
 * icon slot, capitalised name, right-hand value. Collapsed it reads
 * `Asked · <question> … <answer>`; open, the head drops both texts (a head
 * that repeats the question directly above the question reads as a
 * duplicate) and the body carries the full exchange as
 * plain prose with the field names bolded inline.
 *
 * The one question still holding the run is the only emphasis a question
 * ever gets: an amber value with a pulsing dot — never a card.
 */
export function QuestionPart({ part }: { part: Question }) {
  const [open, setOpen] = useState(false);
  const pending = part.state === "pending";
  const skipped = part.state === "skipped";
  const value = pending ? "Waiting on you" : skipped ? "Skipped" : answerValue(part) ?? "—";
  const answerLine = skipped
    ? "Skipped; ShipBash chose a path and continued."
    : answerValue(part);
  const note = part.answer?.note;
  return (
    <div className="x-grp x-qa" data-open={open ? "true" : undefined}>
      <button className="x-grp-head" type="button" aria-expanded={open} onClick={() => { setOpen((was) => !was); }}>
        <ChevronRight className="x-chev" aria-hidden="true" />
        <span className="x-grp-name">
          <MessageSquare className="x-ico" aria-hidden="true" />
          <b>Asked</b>
          <span className="x-qa-q">{part.prompt}</span>
        </span>
        <span
          className="x-grp-ms x-qa-a"
          data-state={pending ? "pending" : skipped ? "skipped" : undefined}
        >
          {value}
        </span>
      </button>
      <div className="x-grp-rows">
        <p className="x-qa-line" data-line="question"><b>Question:</b> {part.prompt}</p>
        {answerLine ? <p className="x-qa-line" data-line="answer"><b>Answer:</b> {answerLine}</p> : null}
        {note ? <p className="x-qa-line" data-line="note"><b>Note:</b> {note}</p> : null}
      </div>
    </div>
  );
}
