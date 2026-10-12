/**
 * The owner's answer to the question an Activity is waiting on, as the
 * answer route delivers it: refused unless
 * the Activity waits on that very question, checked against what it offered,
 * then on the record for the leg to fold (store/activity-interaction.ts).
 */
import type { z } from "zod";

import type { answerActivityContract } from "@shipbash/contracts/api/activities";
import type { PendingActivityQuestion } from "../store/activity-interaction.ts";
import type { TenantActor } from "../types.ts";
import { ApiError } from "./http.ts";
import type { ApiOptions } from "./options.ts";

export type ActivityAnswerBody = z.output<typeof answerActivityContract.body>;

type PendingQuestion = { options: string[]; allowFreeText: boolean };

/**
 * Answers as `actor`, and returns the question answered. The body is read
 * only once the Activity is known to be waiting, so a route refuses a walk
 * that asks nothing before it reads what was sent, and a button that names
 * an option by its place reads it off the question being asked.
 */
export async function answerActivity(
  store: Pick<ApiOptions["store"], "pendingActivityQuestion" | "answerActivityQuestion">,
  actor: TenantActor,
  scope: { teamId: string; projectId: string; activityId: string },
  status: string,
  readBody: (pending: PendingActivityQuestion) => Promise<ActivityAnswerBody>,
): Promise<PendingActivityQuestion> {
  const { teamId, projectId, activityId } = scope;
  if (status !== "waiting_for_input") {
    throw new ApiError(409, "NO_PENDING_QUESTION", "This Activity is not waiting for an answer.");
  }
  const pending = await store.pendingActivityQuestion(actor, teamId, projectId, activityId);
  if (!pending) throw new ApiError(409, "NO_PENDING_QUESTION", "This Activity is not waiting for an answer.");
  const body = await readBody(pending);
  if (body.questionId !== pending.questionId) {
    throw new ApiError(409, "QUESTION_SUPERSEDED", "That question is no longer the one being asked.");
  }
  const answer = validatedAnswer(body, pending);
  await store.answerActivityQuestion(actor, teamId, projectId, activityId, pending, {
    questionId: body.questionId, ...answer,
  });
  return pending;
}

function validatedAnswer(body: ActivityAnswerBody, pending: PendingQuestion) {
  const answer = normalizedAnswer(body);
  validateAnswerShape(answer);
  validateAnswerOption(answer.option, pending.options);
  validateAnswerFreeText(answer.freeText, pending.allowFreeText);
  validateAnswerNote(answer.note, answer.option);
  return answer;
}

function validateAnswerShape(answer: ReturnType<typeof normalizedAnswer>): void {
  if (answer.skipped && (answer.option || answer.freeText || answer.note)) {
    throw new ApiError(400, "INVALID_ANSWER", "A skipped question carries no answer.");
  }
  if (!answer.skipped && ((answer.option === null) === (answer.freeText === null))) {
    throw new ApiError(400, "INVALID_ANSWER", "Answer with exactly one of option or freeText.");
  }
}

function validateAnswerOption(option: string | null, options: string[]): void {
  if (option !== null && !options.includes(option)) {
    throw new ApiError(400, "INVALID_ANSWER", "That option was not offered.");
  }
}

function validateAnswerFreeText(freeText: string | null, allowFreeText: boolean): void {
  if (freeText !== null && !allowFreeText) {
    throw new ApiError(400, "INVALID_ANSWER", "This question does not accept free text.");
  }
}

function validateAnswerNote(note: string | null, option: string | null): void {
  if (note !== null && option === null) {
    throw new ApiError(400, "INVALID_ANSWER", "A note may only accompany a selected option.");
  }
}

function normalizedAnswer(body: ActivityAnswerBody) {
  return {
    option: body.option ?? null,
    freeText: body.freeText ?? null,
    note: body.note ?? null,
    skipped: body.skipped,
  };
}
