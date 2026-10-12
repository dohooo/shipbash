"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { type BoundSignIn, webClient } from "../../lib/web-client";
import { readKey } from "../../lib/queries";
import { METHOD_NAMES, SignInMark } from "./sign-in-methods";

/** What the page asks about the way in verification runs sign in with, when it asks anything. */
type RunChoiceQuestion =
  | { kind: "switch"; from: BoundSignIn; to: BoundSignIn }
  | { kind: "pick"; options: BoundSignIn[] };

/**
 * The first way in a product proves becomes the one its runs sign in with
 * without asking (the server's rule). Every later one that turns ready here is
 * the runs' only when the owner says so; and a product with several ready ways
 * in and none chosen — saved before runs had one — is asked to choose.
 */
function runChoiceQuestion(bound: readonly BoundSignIn[], justReady: string | null): RunChoiceQuestion | null {
  const ready = bound.filter((signIn) => signIn.status === "ready");
  const chosen = bound.find((signIn) => signIn.forRuns);
  if (!chosen) return ready.length > 1 ? { kind: "pick", options: ready } : null;
  const to = ready.find((signIn) => signIn.id === justReady && signIn.id !== chosen.id);
  return to ? { kind: "switch", from: chosen, to } : null;
}

/**
 * The question as an inline card in the rail, two answers and no dialog, like
 * the card's own confirm. Keeping the current way in only puts the question
 * away for the way in that raised it.
 */
export function SignInRunChoice({ projectId, bound, justReady }: {
  projectId: string;
  bound: readonly BoundSignIn[];
  /** The way in this page just proved, if it proved one. */
  justReady: string | null;
}) {
  const queryClient = useQueryClient();
  const [kept, setKept] = useState<string | null>(null);
  const choose = useMutation({
    mutationFn: (signInId: string) => webClient.chooseRunSignIn(projectId, signInId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: readKey("projectSignIns", projectId) }),
  });
  const question = runChoiceQuestion(bound, justReady === kept ? null : justReady);
  if (!question) return null;
  const failed = choose.isError ? <p className="auth-card-reason">ShipBash could not move the runs. Try again.</p> : null;
  if (question.kind === "switch") {
    const { from, to } = question;
    return (
      <div className="auth-card run-choice" data-state="active">
        <SignInMark method={to.method} />
        <span className="auth-card-copy">
          <strong>Switch verification runs to {METHOD_NAMES[to.method]}?</strong>
          <small>They sign in with {METHOD_NAMES[from.method]} now.</small>
        </span>
        <span />
        {failed}
        <div className="auth-card-act">
          <button className="button quiet" disabled={choose.isPending} type="button" onClick={() => setKept(to.id)}>
            Keep {METHOD_NAMES[from.method]}
          </button>
          <button className="button primary" disabled={choose.isPending} type="button" onClick={() => choose.mutate(to.id)}>
            Switch
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="auth-card run-choice" data-state="active">
      <span className="auth-card-copy">
        <strong>Which way in should verification runs use?</strong>
        <small>A run whose session expired signs in again with it.</small>
      </span>
      {failed}
      <div className="auth-card-act">
        {question.options.map((option) => (
          <button className="button" disabled={choose.isPending} key={option.id} type="button" onClick={() => choose.mutate(option.id)}>
            {METHOD_NAMES[option.method]}
          </button>
        ))}
      </div>
    </div>
  );
}
