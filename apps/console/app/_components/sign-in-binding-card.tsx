"use client";

import type { ReactNode } from "react";

import { type SignInFailure, SignInCard, signInFailure, UNCHECKED_FAILURE } from "./sign-in-card";
import { PASSWORD_METHOD } from "./sign-in-methods";
import { SignInPasswordForm } from "./sign-in-password-form";
import type { Binding, BindPhase } from "./use-sign-in-binding";
import type { TakeoverPhase } from "./use-activity-takeover-transition";

/**
 * The one way in being bound right now, as a card. Everything the reader can
 * do about it is here rather than in the step's foot: the card is the thing
 * being finished. A bind that ticked is finished: it reads as a saved bar in
 * the list (savedWaysIn), and this card is gone.
 */

const CARD_STATES: Record<Exclude<BindPhase, "done">, "active" | "verifying" | "failed"> = {
  opening: "active",
  signing_in: "active",
  form: "active",
  verifying: "verifying",
  failed: "failed",
};

/** What the second line says while the bind is still going. */
function cardNote(binding: Binding): ReactNode {
  if (binding.phase === "verifying") return binding.method === PASSWORD_METHOD ? "Signing in on this page…" : "Checking this sign-in…";
  if (binding.method === PASSWORD_METHOD || binding.phase === "failed") return null;
  return "signing in…";
}

interface BindingActions {
  cancel: () => void;
  discard: () => void;
  keepGoing: () => void;
  save: () => void;
  done: () => void;
  draft: (draft: Parameters<typeof SignInPasswordForm>[0]["draft"]) => void;
  reopenForm: (disclosed: boolean) => void;
  retry: () => void;
  signInMyself: () => void;
}

/** Why this bind stopped, and with it the ways out the card offers. */
function bindingFailure(binding: Binding): SignInFailure | null {
  if (binding.phase !== "failed") return null;
  // Nothing judged the credential, so there is nothing to retype: the row is
  // saved and the way out is one more check on it.
  if (binding.unchecked) return UNCHECKED_FAILURE;
  return signInFailure(binding.failureReason, binding.method);
}

function bindingNote(binding: Binding, takeoverPhase: TakeoverPhase | undefined) {
  if (takeoverPhase !== "error") return cardNote(binding);
  return "Browser control was interrupted. Retry to regain control.";
}

export function SignInBindingCard({ binding, actions, takeoverPhase }: {
  binding: Binding;
  actions: BindingActions;
  takeoverPhase?: TakeoverPhase;
}) {
  if (binding.phase === "done") return null;
  const failure = bindingFailure(binding);
  // A failure whose way out is the credential keeps the credential on screen:
  // retyping a password into a form that closed itself is a second failure.
  const form = binding.draft !== null && (binding.phase === "form" || failure?.reopen != null)
    ? binding.draft
    : null;
  return (
    <SignInCard
      actions={{
        addTotp: () => actions.reopenForm(true),
        cancel: actions.cancel,
        discard: actions.discard,
        done: binding.draft ? actions.save : actions.done,
        keepGoing: actions.keepGoing,
        // A lane with something saved to hand over again: a session, or a
        // credential no leg has judged. A credential that was judged keeps its
        // form on screen instead, and the way out of that is the form.
        retry: binding.signInId && (binding.unchecked || !binding.draft) ? actions.retry : undefined,
        signInMyself: actions.signInMyself,
      }}
      confirming={binding.confirming}
      failure={failure}
      method={binding.method}
      note={bindingNote(binding, takeoverPhase)}
      state={CARD_STATES[binding.phase]}
      submit={binding.draft ? "Save and verify" : "I'm done"}
      takeoverPhase={binding.draft ? undefined : takeoverPhase}
    >
      {form ? (
        <SignInPasswordForm
          disclosed={binding.disclosed || failure?.reopen === "disclosure"}
          draft={form}
          onChange={actions.draft}
        />
      ) : null}
    </SignInCard>
  );
}
