"use client";

import type { ReactNode } from "react";
import { TakeoverToggle } from "./takeover-toggle";
import type { TakeoverPhase } from "./use-activity-takeover-transition";

import type { TeamSignIn, TeamSignInMethod } from "../../lib/web-client";
import { METHOD_NAMES, PASSWORD_METHOD, SignInMark } from "./sign-in-methods";

/**
 * One way in, in the state it is actually in. The state and the completing
 * action both sit on the card's own last row, pushed right: the card is the
 * thing being finished, which is what lets the step's primary button carry one
 * label from the first frame to the last.
 */

export const DISCARD_QUESTION = "Discard this sign-in? The browser closes and nothing is kept.";

/**
 * Why a lane stopped, in the vocabulary the row itself is stored in, plus the
 * one word only the card can reach: `removed` is a fact about a row that is no
 * longer there to read a verdict off, not a judgement on the account.
 */
export type SignInFailureReason = NonNullable<TeamSignIn["failureReason"]> | "removed";

/** Where a failure leaves the reader: a specific reason, and the way out of it. */
export interface SignInFailure {
  text: string;
  /** Reopen the credential form, with the second line already unfolded. */
  reopen: "fields" | "disclosure" | null;
  totp: boolean;
  human: boolean;
}

const FAILURES: Partial<Record<SignInFailureReason, SignInFailure>> = {
  wrong_credentials: { text: "Wrong email or password", reopen: "fields", totp: false, human: false },
  second_factor_required: {
    text: "This account asks for a code — add a TOTP secret, or sign in once yourself",
    reopen: null,
    totp: true,
    human: true,
  },
  captcha_required: {
    text: "A CAPTCHA blocks automatic sign-in — sign in once yourself instead",
    reopen: null,
    totp: false,
    human: true,
  },
  login_page_not_found: { text: "No login page found at that URL", reopen: "disclosure", totp: false, human: false },
  // Nothing was judged, so nothing is retyped: the row the card was watching
  // is simply not there any more, and the way on is to save one again.
  removed: { text: "This sign-in was removed", reopen: null, totp: false, human: true },
};

/**
 * Everything a lane can report that the four named judgements do not cover —
 * an expired session, an enforced SSO redirect, a device check, a save that
 * never reached the service. None of them name a thing the reader can read off
 * the screen, so all of them say the one thing that is true of all of them.
 */
const UNKNOWN_FAILURE: SignInFailure = {
  text: "ShipBash could not sign in — sign in once yourself instead",
  reopen: null,
  totp: false,
  human: true,
};

/**
 * A row that was saved and never judged: the call that should have started the
 * check stopped before it did — a check already running, a credential the
 * service cannot open, a deployment missing its sealing key. None of them say
 * anything about the credential, so the card says the one thing that is true:
 * it is saved, and it has not been checked.
 */
export const UNCHECKED_FAILURE: SignInFailure = {
  text: "Saved, but ShipBash could not check it — try again, or sign in once yourself",
  reopen: null,
  totp: false,
  human: true,
};

/**
 * Verdicts only the credential lane can reach. Nobody types a password by hand
 * during a takeover, so a session leg never returns these — and reading one
 * over a Google card would name a field that card does not have.
 */
const CREDENTIAL_ONLY = new Set<SignInFailureReason>(["wrong_credentials", "login_page_not_found"]);

export function signInFailure(reason: SignInFailureReason | null, method: TeamSignInMethod): SignInFailure {
  if (method !== PASSWORD_METHOD) {
    // No credential to retype and no secret to add: the browser is the door.
    const said = reason !== null && !CREDENTIAL_ONLY.has(reason) ? FAILURES[reason] : undefined;
    return { text: (said ?? UNKNOWN_FAILURE).text, reopen: null, totp: false, human: true };
  }
  // The credential stays on screen whatever the reason: retyping a password
  // into a form that closed itself is a second failure.
  return (reason === null ? undefined : FAILURES[reason]) ?? { ...UNKNOWN_FAILURE, reopen: "fields" };
}

export function SignInTick() {
  return (
    <span className="auth-tick" aria-hidden="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5" /></svg>
    </span>
  );
}

interface SignInCardActions {
  cancel?: (() => void) | undefined;
  done?: (() => void) | undefined;
  /** Check the saved session once more, for a lane with nothing to retype. */
  retry?: (() => void) | undefined;
  keepGoing?: (() => void) | undefined;
  discard?: (() => void) | undefined;
  addTotp?: (() => void) | undefined;
  signInMyself?: (() => void) | undefined;
}

/** The inline confirm, per the product's Stop: two choices in the card, not a
 * dialog. The words the buttons carry — keep going, or discard — say the whole
 * of it, so the row asks nothing above them. */
function DiscardRow({ actions }: { actions: SignInCardActions }) {
  return (
    <div className="auth-card-act">
      <button className="button quiet" type="button" onClick={actions.keepGoing}>Keep going</button>
      <button className="button" type="button" onClick={actions.discard}>Discard</button>
    </div>
  );
}

/**
 * The reason above the way out of it. The reason is copy, so it takes a row of
 * the card's own grid: sharing the action row left it as wide as its longest
 * word, and `Wrong email or password` read as three stacked lines of 40px
 * beside the two buttons.
 */
function FailedRow({ failure, actions, submit }: {
  failure: SignInFailure;
  actions: SignInCardActions;
  submit: string;
}) {
  return (
    <>
      <p className="auth-card-reason">{failure.text}</p>
      <div className="auth-card-act">
        {failure.totp ? <button className="button quiet" type="button" onClick={actions.addTotp}>Add TOTP</button> : null}
        {failure.human ? (
          <button className="button" type="button" onClick={actions.signInMyself}>Sign in myself</button>
        ) : null}
        <button className="button quiet" type="button" onClick={actions.cancel}>Cancel</button>
        {/* The fields are still on the card, so the way out is to fix them and send them again. */}
        {failure.reopen ? <button className="button primary" type="button" onClick={actions.done}>{submit}</button> : null}
        {/* Nothing to retype on this lane: the session is saved, so the way out is to check it again. */}
        {!failure.reopen && actions.retry ? (
          <button className="button primary" type="button" onClick={actions.retry}>Try again</button>
        ) : null}
      </div>
    </>
  );
}

/** The completing action, or the state that replaced it, on the last row. */
function CardRow({ state, failure, confirming, actions, submit, takeoverPhase }: {
  state: SignInCardState;
  failure: SignInFailure | null;
  confirming: boolean;
  actions: SignInCardActions;
  submit: string;
  takeoverPhase?: TakeoverPhase | undefined;
}) {
  if (state === "failed" && failure) return <FailedRow actions={actions} failure={failure} submit={submit} />;
  if (takeoverPhase === "error") return <div className="auth-card-act">
    <button className="button primary" type="button" onClick={actions.signInMyself}>Retry browser</button>
    <button className="button quiet" type="button" onClick={actions.cancel}>Cancel</button>
  </div>;
  if (state === "verifying") {
    return (
      <div className="auth-card-act">
        <span className="wait-spinner" aria-hidden="true" />
        <b className="auth-card-word">Verifying…</b>
      </div>
    );
  }
  if (confirming) return <DiscardRow actions={actions} />;
  return (
    <div className="auth-card-act">
      {!takeoverPhase || takeoverPhase === "controlling"
        ? <button className="button quiet" type="button" onClick={actions.cancel}>Cancel</button> : null}
      {takeoverPhase ? <TakeoverToggle phase={takeoverPhase} status="waiting_for_auth"
        onStart={() => {}} onRelease={() => actions.done?.()} />
        : <button className="button primary" type="button" onClick={actions.done}>{submit}</button>}
    </div>
  );
}

type SignInCardState = "active" | "verifying" | "failed";

export function SignInCard({ method, state, note, failure = null, confirming = false,
  submit = "I'm done", takeoverPhase, actions, children }: {
  method: TeamSignInMethod;
  state: SignInCardState;
  /** The line under the name: what is happening, or the account that was read back. */
  note?: ReactNode;
  failure?: SignInFailure | null;
  confirming?: boolean;
  /** What finishing this card is called; the step's own primary never changes. */
  submit?: string;
  takeoverPhase?: TakeoverPhase | undefined;
  actions: SignInCardActions;
  /** The credential form, for the one way in ShipBash types itself. */
  children?: ReactNode;
}) {
  return (
    <div className="auth-card" data-state={state} data-method={method}>
      <SignInMark method={method} />
      <span className="auth-card-copy">
        <strong>{METHOD_NAMES[method]}</strong>
        {note ? <small>{note}</small> : null}
      </span>
      <span />
      {children}
      <CardRow
        actions={actions}
        confirming={confirming}
        failure={failure}
        state={state}
        submit={submit}
        takeoverPhase={takeoverPhase}
      />
    </div>
  );
}
