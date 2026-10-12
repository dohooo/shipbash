"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { readQuery, type TeamRole, webClient } from "../../lib/web-client";
import { apiMessage } from "../_lib/request-errors";
import { readKey } from "../../lib/queries";
import { Dropdown } from "./dropdown";
import { ProfileAvatar, profileHandle } from "./profile-identity";
import { PageSkeleton } from "./page-skeleton";
import { RelativeTime } from "./relative-time";
import {
  PageColumn,
  PageTitle,
  QueryError,
  useWorkspace,
} from "./shell";

function teamError(error: unknown): string {
  return apiMessage(error, "ShipBash could not save this Team change.");
}

type TeamMember = Awaited<ReturnType<typeof webClient.team>>["members"][number];
type TeamInvitation = Awaited<ReturnType<typeof webClient.team>>["invitations"][number];

/** The one clipboard path every copy button on this page takes. */
async function copyInviteLink(inviteUrl: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(inviteUrl);
    toast.success("Invite link copied");
  } catch {
    toast.error("Could not copy the invite link");
  }
}

/**
 * The Admin-only invitation form and the link it produces. The link stays on
 * the page after the automatic copy, so a blocked clipboard is recoverable.
 */
function InviteMember({ githubLogin, onGithubLogin, onSubmit, pending, inviteUrl }: {
  githubLogin: string;
  onGithubLogin: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  inviteUrl: string | null;
}) {
  return (
    <section className="invite" aria-labelledby="invite-title">
      <h2 id="invite-title">Invite a member</h2>
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <label className="form-field"><span>GitHub username</span><input value={githubLogin} onChange={(event) => onGithubLogin(event.target.value)} required maxLength={100} autoCapitalize="none" autoCorrect="off" /></label>
        <button className="button primary" type="submit" disabled={pending || !githubLogin.trim()}>Create invite link</button>
      </form>
      {inviteUrl !== null ? (
        <div className="invite-link" role="status">
          <input aria-label="Invitation link" readOnly value={inviteUrl} />
          <button className="button" type="button" onClick={() => void copyInviteLink(inviteUrl)}>Copy link</button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Who is on the Team. An Admin gets a row menu for everyone but themselves;
 * everyone else reads the same roster without controls.
 */
function MemberRoster({ members, isAdmin, selfUserId, onSetRole, onRemove }: {
  members: readonly TeamMember[];
  isAdmin: boolean;
  selfUserId: string;
  onSetRole: (userId: string, role: TeamRole) => void;
  onRemove: (userId: string) => void;
}) {
  return (
    <section className="settings-card" aria-labelledby="members-title">
      <div className="settings-card-head"><div><h2 id="members-title">Members</h2><p>Everyone with access to this workspace.</p></div></div>
      <ul className="settings-list team-roster">
        {members.map((member) => (
          <li key={member.userId}>
            <ProfileAvatar profile={member} />
            <span className="roster-name"><strong>{member.displayName}</strong><span>{profileHandle(member)}</span></span>
            <span className="role">{member.role}</span>
            {isAdmin && member.userId !== selfUserId ? (
              <Dropdown.Root className="row-menu">
                <Dropdown.Trigger aria-label={`Manage ${member.displayName}`}><MoreHorizontal aria-hidden="true" /></Dropdown.Trigger>
                <Dropdown.Content className="row-menu-content">
                  <Dropdown.Close>
                    <button type="button" onClick={() => onSetRole(member.userId, member.role === "admin" ? "member" : "admin")}>
                      Make {member.role === "admin" ? "member" : "admin"}
                    </button>
                  </Dropdown.Close>
                  <Dropdown.Close><button type="button" onClick={() => onRemove(member.userId)}>Remove</button></Dropdown.Close>
                </Dropdown.Content>
              </Dropdown.Root>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Invitations nobody has accepted yet. An invitation's token is minted once
 * and only ever stored hashed, so the row can offer the link for the one this
 * session created and nothing else — what is gone is gone, and a new
 * invitation is the way back to a link.
 */
function PendingInvitations({ invitations, isAdmin, freshLink, onRevoke }: {
  invitations: readonly TeamInvitation[];
  isAdmin: boolean;
  freshLink: { invitationId: string; inviteUrl: string } | null;
  onRevoke: (invitationId: string) => void;
}) {
  if (!invitations.length) return null;
  return (
    <section className="settings-card" aria-labelledby="invitations-title">
      <div className="settings-card-head"><div><h2 id="invitations-title">Pending invitations</h2><p>Invitations that have not been accepted yet.</p></div></div>
      <ul className="settings-list team-invitations">
        {invitations.map((invitation) => (
          <li key={invitation.id}>
            <span className="roster-name"><strong>@{invitation.invitedGithubLogin}</strong><span>Expires <RelativeTime value={invitation.expiresAt} /></span></span>
            <span className="status"><span aria-hidden="true" />Pending</span>
            {freshLink?.invitationId === invitation.id ? (
              <button className="button" type="button" onClick={() => void copyInviteLink(freshLink.inviteUrl)}>Copy invite link</button>
            ) : null}
            {isAdmin ? <button className="button quiet" type="button" onClick={() => onRevoke(invitation.id)}>Revoke</button> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

const TEAM_BODY = "Who can see and change this workspace, and which products it verifies.";

/** The page's frame and title before the roster answers: the members list takes shape below. */
export function TeamSkeleton() {
  return <PageSkeleton className="page narrow-page" eyebrow title="Team" body={TEAM_BODY} shape="rows" />;
}

function TeamContent() {
  const queryClient = useQueryClient();
  const { session, team } = useWorkspace();
  const [githubLogin, setGithubLogin] = useState("");
  const [inviting, setInviting] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const query = useQuery(readQuery("team", team.id));
  const invite = useMutation({
    mutationFn: () => webClient.inviteMember(team.id, githubLogin),
    onSuccess: async ({ inviteUrl }) => {
      setGithubLogin("");
      await queryClient.invalidateQueries({ queryKey: readKey("team", team.id) });
      try {
        await navigator.clipboard.writeText(inviteUrl);
        toast.success("Invite link copied");
      } catch {
        toast.success("Invite link created", { description: "Copy it from the invitation field." });
      }
    },
  });
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamRole }) => webClient.setMemberRole(team.id, userId, role),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("team", team.id) });
      toast.success("Member role updated");
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => webClient.removeMember(team.id, userId),
    // The confirmation closes once the team has been read again, so the member
    // it removed is never listed under it.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("team", team.id) });
      setRemovingUserId(null);
      toast.success("Member removed");
    },
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) => webClient.revokeInvitation(team.id, invitationId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("team", team.id) });
      toast.success("Invitation revoked");
    },
  });

  if (query.isPending) return <TeamSkeleton />;
  if (query.isLoadingError) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const mutationError = invite.error ?? setRole.error ?? remove.error ?? revoke.error;
  const isAdmin = team.role === "admin";
  // An invitation names a GitHub account, which only a deployment with GitHub can check.
  const canInvite = isAdmin && session.integrations.github;
  return (
    <div className="page narrow-page">
      <PageTitle
        eyebrow={team.name}
        title="Team"
        body={TEAM_BODY}
        actions={canInvite ? (
          <button className="button primary" type="button" aria-expanded={inviting} onClick={() => setInviting(!inviting)}>
            <Plus aria-hidden="true" />Invite people
          </button>
        ) : null}
      />
      {canInvite && inviting ? (
        <InviteMember
          githubLogin={githubLogin}
          onGithubLogin={setGithubLogin}
          onSubmit={() => invite.mutate()}
          pending={invite.isPending}
          inviteUrl={invite.data ? invite.data.inviteUrl : null}
        />
      ) : null}
      {mutationError ? <p className="inline-error" role="alert">{teamError(mutationError)}</p> : null}
      <MemberRoster
        members={query.data.members}
        isAdmin={isAdmin}
        selfUserId={session.profile.userId}
        onSetRole={(userId, role) => setRole.mutate({ userId, role })}
        onRemove={setRemovingUserId}
      />
      {removingUserId ? (
        <dialog className="confirmation" open aria-labelledby="remove-member-title" aria-describedby="remove-member-description">
          <div>
            <strong id="remove-member-title">Remove this member?</strong>
            <p id="remove-member-description">They will immediately lose access to this Team.</p>
          </div>
          <div className="actions-row">
            <button className="button" type="button" onClick={() => setRemovingUserId(null)}>Cancel</button>
            <button className="button danger" type="button" disabled={remove.isPending} onClick={() => remove.mutate(removingUserId)}>Remove member</button>
          </div>
        </dialog>
      ) : null}
      <PendingInvitations
        invitations={query.data.invitations.filter((item) => item.status === "pending")}
        isAdmin={isAdmin}
        freshLink={invite.data ? { invitationId: invite.data.invitation.id, inviteUrl: invite.data.inviteUrl } : null}
        onRevoke={(invitationId) => revoke.mutate(invitationId)}
      />
    </div>
  );
}

export function TeamPage() {
  return <PageColumn><TeamContent /></PageColumn>;
}

/**
 * Profile: how the reader appears to everyone else. Theirs, not the team's and
 * not a product's — so it has an address of its own that names neither, rather
 * than a column beside the things a team shares. The way in is the avatar at
 * the foot of the rail; the shell crumbs it from the address, as it does Team.
 */
export function ProfilePage() {
  return (
    <PageColumn>
      <div className="page narrow-page">
        <PageTitle title="Profile" titleHidden />
        <ProfileCard />
      </div>
    </PageColumn>
  );
}

function ProfileCard() {
  const queryClient = useQueryClient();
  const { session } = useWorkspace();
  const [displayName, setDisplayName] = useState(session.profile.displayName);
  const mutation = useMutation({
    mutationFn: () => webClient.updateProfile(displayName),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: readKey("session") });
      toast.success("Profile saved");
    },
  });
  return (
    <section className="settings-card" aria-labelledby="profile-title">
      <div className="settings-card-head">
        <div>
          <h2 id="profile-title">Profile</h2>
          <p>How you appear to everyone else. Yours, not the team&apos;s.</p>
        </div>
      </div>
      <div className="profile-identity">
        <ProfileAvatar profile={session.profile} />
        <div><strong>{session.profile.displayName}</strong><span>{profileHandle(session.profile)}</span></div>
      </div>
      <form className="form-section" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
        <label className="form-field"><span>Display name</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={120} /></label>
        {mutation.isError ? <p className="inline-error" role="alert">{teamError(mutation.error)}</p> : null}
        <button className="button primary" type="submit" disabled={mutation.isPending || !displayName.trim()}>Save profile</button>
      </form>
    </section>
  );
}
