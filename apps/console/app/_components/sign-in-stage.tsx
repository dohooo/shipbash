"use client";

import type { BoundSignIn, Project, TeamSignIn } from "../../lib/web-client";
import { barHost } from "./sign-in-bar";
import { SignInBindingCard } from "./sign-in-binding-card";
import { SignInBrowser, SIGNED_IN_COPY } from "./sign-in-browser";
import { DISCARD_QUESTION } from "./sign-in-card";
import { savedWaysIn, SignInCardList } from "./sign-in-card-list";
import { SignInRunChoice } from "./sign-in-run-choice";
import { railHead } from "./sign-in-setup-head";
import { useLeaveGuard } from "./use-leave-guard";
import { useSignInBinding } from "./use-sign-in-binding";

/**
 * The bind both routes that save a way in run: the setup step and Add a way
 * in. One browser and one session: a bind is not over until it is ticked or
 * let go, so the rest of the page waits for the card's own Cancel or I'm done.
 * Only the one losable state is held, and it is held on the route because that
 * is what leaving the page means here.
 */
export function useSignInStage(project: Project, bound: readonly TeamSignIn[]) {
  const bind = useSignInBinding(project);
  const binding = bind.binding;
  const busy = binding !== null && binding.phase !== "done";
  useLeaveGuard({ active: Boolean(binding?.touched) && bind.stream.requested, message: DISCARD_QUESTION });
  const head = railHead(binding, bound, barHost(project.productionUrl));
  return { bind, binding, busy, head };
}

/**
 * The stage's two columns: the browser on the left, the ways in as the right
 * rail. A bind holds the rail's card while it runs; once none does, the card is
 * the question about the way in verification runs sign in with, when there is one.
 */
export function SignInStageBody({ project, bound, stage }: {
  project: Project;
  bound: readonly BoundSignIn[];
  stage: ReturnType<typeof useSignInStage>;
}) {
  const { bind, binding, busy, head } = stage;
  return (
    <>
      <SignInBrowser
        address={project.productionUrl ?? ""}
        asked={busy}
        idleCopy={binding?.phase === "done" ? SIGNED_IN_COPY : undefined}
        controlToken={bind.stream.controlToken}
        onDrive={bind.actions.drive}
        requested={bind.stream.requested}
        streamUrl={bind.stream.url}
        phase={bind.presentation.phase}
        snapshot={bind.presentation.snapshot}
        onControlReady={bind.presentation.controlReady}
        onControlLost={bind.presentation.controlLost}
        onFrozen={bind.presentation.frozen}
        onPresentationChange={bind.presentation.presentationChanged}
      />
      <SignInCardList
        blocked={busy}
        card={binding && busy ? <SignInBindingCard actions={bind.actions} binding={binding}
          takeoverPhase={bind.presentation.phase} /> : (
          <SignInRunChoice bound={bound} justReady={binding?.phase === "done" ? binding.signInId : null}
            projectId={project.id} />
        )}
        lede={head.lede}
        method={binding?.method ?? null}
        onPick={bind.actions.pick}
        saved={savedWaysIn(bound, binding)}
        title={head.title}
      />
    </>
  );
}
