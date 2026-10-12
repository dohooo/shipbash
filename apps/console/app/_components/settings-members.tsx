"use client";

/**
 * Team → Members: who can see and change things here. The roster is the same
 * one the Team page keeps; changing it — inviting, roles, removals — is that
 * page's job, so this pane reads and points at it rather than owning a second
 * editor that can disagree with the first.
 *
 * What it does own is the other direction: people who opened a run here and
 * asked to be let in. They land above the roster, because granting one is
 * adding a member and the answer belongs beside the list it changes.
 */
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import Link from "next/link";

import { readQuery, webClient } from "../../lib/web-client";
import { apiMessage } from "../_lib/request-errors";
import { readKey } from "../../lib/queries";
import { ProfileAvatar, profileHandle } from "./profile-identity";
import { RelativeTime } from "./relative-time";
import { useWorkspace } from "./shell";

type TeamPayload = Awaited<ReturnType<typeof webClient.team>>;
type AccessRequest = TeamPayload["accessRequests"][number];

function AccessRequests({ requests, teamId }: { requests: readonly AccessRequest[]; teamId: string }) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ requestId, decision }: { requestId: string; decision: "approve" | "decline" }) =>
      webClient.resolveAccessRequest(teamId, requestId, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: readKey("team", teamId) }),
  });
  return (
    <section className="settings-card" aria-labelledby="access-requests-title">
      <div className="settings-card-head">
        <div>
          <h2 id="access-requests-title">Access requests</h2>
          <p>Someone opened a run in this team and asked to be let in.</p>
        </div>
        <span className="status">
          <span aria-hidden="true" />
          {requests.length} waiting
        </span>
      </div>
      {decide.error ? (
        <p className="inline-error" role="alert">
          {apiMessage(decide.error, "ShipBash could not answer this request.")}
        </p>
      ) : null}
      <ul className="settings-list signin-list">
        {requests.map((request) => (
          <li key={request.id}>
            <span className="avatar" aria-hidden="true">
              {request.requester.replace(/^@/u, "").slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{request.requester}</strong>
              <RelativeTime value={request.createdAt} />
            </span>
            <div className="signin-actions">
              {/* Declining says nothing to the requester; the row simply leaves. */}
              <button
                className="button quiet"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ requestId: request.id, decision: "decline" })}
                type="button"
              >
                <X aria-hidden="true" />
                Decline
              </button>
              <button
                className="button primary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ requestId: request.id, decision: "approve" })}
                type="button"
              >
                <Check aria-hidden="true" />
                Add as member
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MembersPane() {
  const { team, teamHref } = useWorkspace();
  const { data } = useSuspenseQuery(readQuery("team", team.id));
  // The service answers with the requests this reader can grant and no others,
  // so the card appears for exactly the roles that already manage members.
  const requests = data.accessRequests;
  return (
    <>
      {requests.length > 0 ? <AccessRequests requests={requests} teamId={team.id} /> : null}
      <section className="settings-card" aria-labelledby="members-title">
        <div className="settings-card-head">
          <div>
            <h2 id="members-title">Members</h2>
            <p>Who can see and change things in {team.name}.</p>
          </div>
          <Link className="button" href={teamHref("/team")}>Manage team</Link>
        </div>
        <ul className="settings-list">
          {data.members.map((member) => (
            <li key={member.userId}>
              <ProfileAvatar profile={member} />
              <span>
                <strong>{member.displayName}</strong>
                <span>{profileHandle(member)}</span>
              </span>
              <span className="role">{member.role}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
