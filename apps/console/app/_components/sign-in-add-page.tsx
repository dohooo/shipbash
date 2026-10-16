"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { BoundSignIn } from "../../lib/web-client";
import { readQuery } from "../../lib/web-client";
import { PageColumn, PageTitle, ProductGate, QueryError, useProduct } from "./shell";
import { PageSkeleton } from "./page-skeleton";
import { PASSWORD_METHOD } from "./sign-in-methods";
import { GitHubAuthenticatorAction, GitHubAuthenticatorEditor } from "./github-authenticator";
import { SignInStageBody, useSignInStage } from "./sign-in-stage";
import type { Binding } from "./use-sign-in-binding";

/**
 * Adding a way in from a product's settings, or signing in again to one the
 * product already uses, as an address of its own.
 *
 * A route of its own rather than a modal: settings is a narrow page and the
 * browser wants the width, the job already has a go in, finish,
 * come back shape, and only a route gives a link worth sharing, a refresh that
 * returns, and somewhere for the leaving guard to hang.
 *
 * The stage is the setup step's, in the mode that carries a browser — the same
 * components, not a second implementation of them.
 */

/** Said once, in the foot, while a bind holds the one browser there is. */
function ConcurrencyNote() {
  return (
    <p className="signin-modal-note">
      <TriangleAlert aria-hidden="true" />
      <span>One browser, one sign-in at a time.</span>
    </p>
  );
}

function GitHubAuthenticatorOffer({ projectId, binding }: { projectId: string; binding: Binding | null }) {
  const [open, setOpen] = useState(false);
  if (binding?.phase !== "done" || binding.method !== "github" || !binding.signInId) return null;
  return (
    <section className="settings-card" aria-label="GitHub authenticator">
      {open ? (
        <GitHubAuthenticatorEditor projectId={projectId} signInId={binding.signInId} onClose={() => setOpen(false)} />
      ) : (
        <div className="settings-card-head">
          <div>
            <h2>GitHub authenticator</h2>
            <p>If this GitHub account uses an authenticator app, save its setup key for future sign-ins.</p>
          </div>
          <GitHubAuthenticatorAction projectId={projectId} signInId={binding.signInId} onOpen={() => setOpen(true)} />
        </div>
      )}
    </section>
  );
}

/**
 * Signing in again opens the way in's browser on arrival: the press that led
 * here was the ask, and the page has nothing else to offer before it.
 */
function useOpenOnArrival(pick: (method: BoundSignIn["method"], signInId: string) => void, again: BoundSignIn | null) {
  const asked = useRef(false);
  useEffect(() => {
    if (!again || asked.current) return;
    asked.current = true;
    pick(again.method, again.id);
  }, [again, pick]);
}

function AddStage({ bound, again, title }: {
  bound: readonly BoundSignIn[];
  /** The saved way in being signed in to again; null adds a new one. */
  again: BoundSignIn | null;
  title: string;
}) {
  const router = useRouter();
  const { project, teamHref } = useProduct();
  const settings = teamHref("/settings/sign-ins");
  const stage = useSignInStage(project, bound);
  const { binding, busy } = stage;
  useOpenOnArrival(stage.bind.actions.pick, again);
  return (
    <div className="page signin-add-page">
      <PageTitle
        actions={<Link className="button" href={settings}><ChevronLeft aria-hidden="true" />Back to settings</Link>}
        inlineActions
        title={title}
      />
      <section className="workbench signin-add-stage" aria-label={title}>
        {/* This route is always bind mode, so the stage carries its own at-rest
            placeholder: the question before a pick, and what just happened once
            a bind has ticked and handed the browser back. Same reading as the
            setup step, which is the other route that binds. */}
        <div className="auth-stage" data-mode="bind">
          <SignInStageBody project={project} bound={bound} stage={stage} />
        </div>
        <footer className="workbench-foot">
          {busy ? <ConcurrencyNote /> : null}
          <div className="workbench-actions">
            {/* A link, so the guard that holds a half-finished sign-in sees it. */}
            <Link className="button quiet" href={settings}>Cancel</Link>
            <button className="button primary" type="button" disabled={busy} onClick={() => router.push(settings)}>
              Save and go back
            </button>
          </div>
        </footer>
      </section>
      <GitHubAuthenticatorOffer projectId={project.id} binding={binding} />
    </div>
  );
}

/** A way in this product does not use, or one ShipBash signs in with itself, has no browser to give back. */
function NotSignedInAgain({ title }: { title: string }) {
  const { teamHref } = useProduct();
  return (
    <div className="page signin-add-page">
      <PageTitle title={title} />
      <section className="settings-card">
        <p>This product does not sign in with that way in.</p>
        <Link className="button" href={teamHref("/settings/sign-ins")}><ChevronLeft aria-hidden="true" />Back to settings</Link>
      </section>
    </div>
  );
}

function AddContent({ againId }: { againId: string | null }) {
  const { project } = useProduct();
  const signIns = useQuery(readQuery("projectSignIns", project.id));
  const title = againId ? "Sign in again" : "Add a way in";

  if (signIns.isPending) {
    return <SignInAddSkeleton title={title} />;
  }
  if (signIns.isLoadingError) return <QueryError error={signIns.error} retry={() => void signIns.refetch()} />;
  if (!againId) return <AddStage bound={signIns.data.signIns} again={null} title={title} />;
  const again = signIns.data.signIns.find((signIn) => signIn.id === againId);
  if (!again || again.method === PASSWORD_METHOD) return <NotSignedInAgain title={title} />;
  return <AddStage bound={signIns.data.signIns} again={again} title={title} />;
}

/** Saving a way in, before the product's sign-ins answer. */
export function SignInAddSkeleton({ title }: { title: string }) {
  return <PageSkeleton className="page signin-add-page" title={title} />;
}

export function SignInAddPage() {
  return <ProductGate><PageColumn><AddContent againId={null} /></PageColumn></ProductGate>;
}

/** Signing in again to a saved way in: the same page, opened on that way in's browser. */
export function SignInAgainPage({ signInId }: { signInId: string }) {
  return <ProductGate><PageColumn><AddContent againId={signInId} /></PageColumn></ProductGate>;
}
