"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { webClient } from "../../lib/web-client";
import { scopePath } from "./workspace-address";

export function InvitationAcceptance({ token }: { token: string }) {
  const router = useRouter();
  const acceptance = useMutation({
    mutationFn: () => webClient.acceptInvitation(token),
    onSuccess: ({ teamId }) => {
      router.replace(scopePath(teamId, null));
      router.refresh();
    },
  });

  return (
    <section className="auth-panel" aria-labelledby="invitation-title">
      <p className="mono auth-kicker">ShipBash</p>
      <h1 id="invitation-title">Join this team</h1>
      <p className="auth-description">
        Your signed-in GitHub identity must match the person this invitation was created for.
      </p>
      {acceptance.isError ? (
        <p className="form-error" role="alert">
          {acceptance.error instanceof Error
            ? acceptance.error.message
            : "This invitation could not be accepted."}
        </p>
      ) : null}
      <button
        className="button primary auth-submit"
        disabled={acceptance.isPending}
        onClick={() => acceptance.mutate()}
        type="button"
      >
        {acceptance.isPending ? "Joining…" : "Join team"}
      </button>
    </section>
  );
}
