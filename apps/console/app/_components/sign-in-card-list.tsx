"use client";

import type { ReactNode } from "react";

import type { TeamSignIn, TeamSignInMethod } from "../../lib/web-client";
import { SignInTick } from "./sign-in-card";
import { METHOD_GROUPS, METHOD_NAMES, METHOD_OPTIONS, SignInGlyph } from "./sign-in-methods";
import type { Binding } from "./use-sign-in-binding";

/** A way in as its bar reads it: which method, and whether a leg has proved it. */
type SavedWayIn = Pick<TeamSignIn, "id" | "method" | "status">;

/**
 * The bars beside the card: the ways in this project has bound, less the one
 * still being bound. A bind that just ticked is a bar at once — the row the
 * list refetches, or, until that refetch lands, the bind's own tick — so the
 * card never stays open on a way in that is already saved.
 */
export function savedWaysIn(bound: readonly TeamSignIn[], binding: Binding | null): SavedWayIn[] {
  if (!binding) return [...bound];
  if (binding.phase !== "done") return bound.filter((signIn) => signIn.id !== binding.signInId);
  if (!binding.signInId || bound.some((signIn) => signIn.id === binding.signInId)) return [...bound];
  return [...bound, { id: binding.signInId, method: binding.method, status: "ready" }];
}

// Methods outside this set are listed but disabled and marked Soon.
const AVAILABLE_METHODS = new Set<TeamSignInMethod>(["github", "email_password", "any_login_page"]);

/**
 * The list of ways in, and the only one of it there is.
 *
 * The reader picks from this list in the middle of an empty step, and then goes
 * on reading the same list narrowed into a rail beside the browser. It is one
 * component in one place in the tree, laid out twice by the stage's mode — so
 * the cards the reader was reading are the cards they keep, rather than a
 * second list that happens to say the same things.
 */

/** Keep the original sign-in method name; the tick carries its saved status. */
function SavedBar({ signIn }: { signIn: SavedWayIn }) {
  const ready = signIn.status === "ready";
  return (
    <div className={ready ? "done-bar tinted" : "done-bar"} data-method={signIn.method}>
      <SignInGlyph method={signIn.method} />
      <span className="done-bar-label">{METHOD_NAMES[signIn.method]}</span>
      {ready ? <SignInTick /> : <span className="auth-card-word">Not verified</span>}
    </div>
  );
}

function OptionGroup({ title, methods, reason, onPick }: {
  title: string;
  methods: readonly TeamSignInMethod[];
  /** Said once per group while another sign-in holds the browser, never once per option. */
  reason: string | null;
  onPick: (method: TeamSignInMethod) => void;
}) {
  if (methods.length === 0) return null;
  return (
    <div className="v3-sec">
      {title ? <h4>{title}</h4> : null}
      {reason ? <p className="auth-group-note">{reason}</p> : null}
      <div className="v3-bars">
        {methods.map((method) => (
          <button
            className="v3-bar"
            data-method={method}
            disabled={reason !== null || !AVAILABLE_METHODS.has(method)}
            key={method}
            onClick={() => onPick(method)}
            type="button"
          >
            <SignInGlyph method={method} />
            <span>{METHOD_OPTIONS[method]}</span>
            {!AVAILABLE_METHODS.has(method) ? <span className="v3-bar-soon">Soon</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SignInCardList({ title, lede, card, method, blocked, saved, onPick }: {
  title: string;
  lede: string;
  /** The card at the head of the list: the way in being bound right now, or a question about the one runs use. */
  card: ReactNode;
  /** What that card is a way in through, so its own option leaves the groups. */
  method: TeamSignInMethod | null;
  /** True while that bind holds the browser, which is what disables the rest. */
  blocked: boolean;
  /** The ways in this project has already saved, folded to bars. */
  saved: readonly SavedWayIn[];
  onPick: (method: TeamSignInMethod) => void;
}) {
  const taken = new Set<TeamSignInMethod>(saved.map((signIn) => signIn.method));
  if (method) taken.add(method);
  const reason = blocked && method ? `Finish or cancel the ${METHOD_NAMES[method]} sign-in first.` : null;
  return (
    <div className="auth-side">
      <div className="auth-side-head">
        <strong>{title}</strong>
        <small>{lede}</small>
      </div>
      <div className="auth-side-list">
        {card}
        {saved.length > 0 ? (
          <div className="v3-bars">
            {saved.map((signIn) => <SavedBar key={signIn.id} signIn={signIn} />)}
          </div>
        ) : null}
        {METHOD_GROUPS.map((group) => (
          <OptionGroup
            key={group.title}
            methods={group.methods.filter((method) => !taken.has(method))}
            onPick={onPick}
            reason={reason}
            title={group.title}
          />
        ))}
      </div>
    </div>
  );
}
