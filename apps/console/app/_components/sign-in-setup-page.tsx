"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import type { BoundSignIn } from "../../lib/web-client";
import { readQuery } from "../../lib/web-client";
import { PageColumn, PageTitle, ProductGate, QueryError, useProduct } from "./shell";
import { PageSkeleton } from "./page-skeleton";
import { SignInBar } from "./sign-in-bar";
import { SignInStageBody, useSignInStage } from "./sign-in-stage";
import { useStartDiscovery } from "./start-discovery";

/**
 * The step after the project exists: the ways ShipBash signs in, saved before
 * the first exploration rather than discovered by hitting a wall during it.
 *
 * It takes the whole content area as the run page's own shell, because a live
 * browser does not fit inside the onboarding panel and stacking one there would
 * put nested scroll contexts around the one thing the reader is looking at. The
 * Production URL the step behind it settled moves into the bottom bar, beside
 * the sign-ins saved here.
 *
 * Discover journeys starts exploration; Skip opens the project without
 * starting a run. Saved sign-ins remain available for later exploration.
 */
function SetupStage({ bound }: {
  /** The ways in this project has bound, whatever the lane has proved about them. */
  bound: readonly BoundSignIn[];
}) {
  const router = useRouter();
  const { project, teamHref } = useProduct();
  const stage = useSignInStage(project, bound);
  const discover = useStartDiscovery(project);
  const { bind, busy } = stage;
  return (
    <div className="sign-in-setup-page">
      <PageTitle title="Sign-ins" titleHidden />
      <section className="workbench auth-step" aria-label="Sign-ins">
        {/* Pick and bind are the same two-column stage: the browser is on the
            left from the first frame — the brand at-rest placeholder while no
            bind holds it (asked=false), the live canvas during one — and the
            list is the right rail throughout. The mode still switches so the
            step ends at the picture only while a bind holds it, and so the head
            reads the question before a pick and the card during one.

            A ticked bind has handed the browser back, so the stage rests again;
            it rests on what just happened rather than on the question the
            reader has already answered.

            The stage ends on text, not on a picture: the stream endpoint
            exists only while a sign-in is verifying, and this stage keeps no
            final screenshot. */}
        <div className="workbench-body auth-stage" data-mode={busy ? "bind" : "pick"}>
          <SignInStageBody project={project} bound={bound} stage={stage} />
        </div>
        <SignInBar
          busy={busy || discover.isPending}
          onDiscover={() => discover.mutate()}
          onSkip={() => { bind.actions.discard(); router.push(teamHref("/", { project: project.slug })); }}
          productionUrl={project.productionUrl}
          ready={bound.filter((signIn) => signIn.status === "ready")}
        />
      </section>
    </div>
  );
}

function SetupContent() {
  const { project } = useProduct();
  const signIns = useQuery(readQuery("projectSignIns", project.id));

  if (signIns.isPending) {
    return <SignInSetupSkeleton />;
  }
  if (signIns.isLoadingError) return <QueryError error={signIns.error} retry={() => void signIns.refetch()} />;

  return <SetupStage bound={signIns.data.signIns} />;
}

/** Getting the product's sign-ins set up, before they answer. */
export function SignInSetupSkeleton() {
  return <PageSkeleton className="sign-in-setup-page" title="Sign-ins" titleHidden />;
}

export function SignInSetupPage() {
  return <ProductGate><PageColumn><SetupContent /></PageColumn></ProductGate>;
}
