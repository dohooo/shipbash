"use client";

import type { ReactNode } from "react";

import type { TeamSignIn } from "../../lib/web-client";
import { SignInGlyph } from "./sign-in-methods";

/**
 * What the step behind this one settled, and what this one has saved so far,
 * stated as facts rather than as a wizard the reader can walk back into — the
 * project exists now.
 *
 * Label over value. The rows are pinned rather than sized by their contents:
 * a pair's height must not depend on whether it carries a sign-in glyph, or
 * one label lands a pixel and a half off the other.
 */

/** The host, as a person reads it — a scheme in a fact line is noise. */
export function barHost(productionUrl: string | null): string {
  return (productionUrl ?? "").replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
}

/** `None saved` until a leg has landed inside the product with one of them. */
function signInsValue(ready: readonly TeamSignIn[]): string {
  if (ready.length === 0) return "None saved";
  return `${String(ready.length)} ready`;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="auth-bar-fact">
      <span>{label}</span>
      <span className="auth-bar-value">{children}</span>
    </span>
  );
}

export function SignInBar({ productionUrl, ready, busy, onDiscover, onSkip }: {
  productionUrl: string | null;
  /** The ways in that a verification leg has actually landed with. */
  ready: readonly TeamSignIn[];
  busy: boolean;
  onDiscover: () => void;
  onSkip: () => void;
}) {
  return (
    <footer className="workbench-foot auth-bar">
      <div className="auth-bar-facts">
        <Fact label="Production URL"><strong>{barHost(productionUrl)}</strong></Fact>
        <span className="auth-bar-sep" aria-hidden="true" />
        <Fact label="Sign-ins">
          {ready.map((signIn) => <SignInGlyph key={signIn.id} method={signIn.method} />)}
          <strong>{signInsValue(ready)}</strong>
        </Fact>
      </div>
      <div className="workbench-actions">
        <button className="button quiet" type="button" disabled={busy} onClick={onSkip}>
          Skip
        </button>
        <button className="button primary" type="button" disabled={busy} onClick={onDiscover}>
          Discover journeys
        </button>
      </div>
    </footer>
  );
}
