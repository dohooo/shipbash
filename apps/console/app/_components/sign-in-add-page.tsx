"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { BoundSignIn } from "../../lib/web-client";
import { readQuery } from "../../lib/web-client";
import { PageColumn, PageTitle, ProductGate, QueryError, useProduct } from "./shell";
import { PageSkeleton } from "./page-skeleton";
import { GitHubAuthenticatorAction, GitHubAuthenticatorEditor } from "./github-authenticator";
import { SignInStageBody, useSignInStage } from "./sign-in-stage";
import type { Binding } from "./use-sign-in-binding";

/**
 * Adding a way in from a product's settings, as an address of its own.
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

function AddStage({ bound }: { bound: readonly BoundSignIn[] }) {
  const router = useRouter();
  const { project, teamHref } = useProduct();
  const settings = teamHref("/settings/sign-ins");
  const stage = useSignInStage(project, bound);
  const { binding, busy } = stage;
  return (
    <div className="page signin-add-page">
      <PageTitle
        actions={<Link className="button" href={settings}><ChevronLeft aria-hidden="true" />Back to settings</Link>}
        inlineActions
        title="Add a way in"
      />
      <section className="workbench signin-add-stage" aria-label="Add a way in">
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

function AddContent() {
  const { project } = useProduct();
  const signIns = useQuery(readQuery("projectSignIns", project.id));

  if (signIns.isPending) {
    return <SignInAddSkeleton />;
  }
  if (signIns.isLoadingError) return <QueryError error={signIns.error} retry={() => void signIns.refetch()} />;
  return <AddStage bound={signIns.data.signIns} />;
}

/** Saving a way in, before the product's sign-ins answer. */
export function SignInAddSkeleton() {
  return <PageSkeleton className="page signin-add-page" title="Add a way in" />;
}

export function SignInAddPage() {
  return <ProductGate><PageColumn><AddContent /></PageColumn></ProductGate>;
}
