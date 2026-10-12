import {
  acceptInvitationContract,
  createInvitationContract,
  removeTeamMemberContract,
  revokeInvitationContract,
  updateProfileContract,
  updateTeamMemberContract,
} from "@shipbash/contracts/api/account";
import {
  requestTeamAccessContract,
  resolveTeamAccessRequestContract,
} from "@shipbash/contracts/api/team-access";
import { callApi } from "./api-client";
import type { TeamRole } from "./web-client-types";

export const accountClient = {
  inviteMember: (teamId: string, githubLogin: string) => callApi(createInvitationContract, {
    params: { teamId },
    body: { githubLogin },
  }),
  revokeInvitation: (teamId: string, invitationId: string) => callApi(revokeInvitationContract, {
    params: { teamId, invitationId },
  }),
  setMemberRole: (teamId: string, userId: string, role: TeamRole) => callApi(
    updateTeamMemberContract,
    { params: { teamId, userId }, body: { role } },
  ),
  removeMember: (teamId: string, userId: string) => callApi(removeTeamMemberContract, {
    params: { teamId, userId },
  }),
  updateProfile: (displayName: string) => callApi(updateProfileContract, {
    body: { displayName },
  }),
  acceptInvitation: (token: string) => callApi(acceptInvitationContract, {
    body: { token },
  }),
  /** The Team is addressed the way the URL names it; the reader is not in it yet. */
  requestTeamAccess: (team: string) => callApi(requestTeamAccessContract, {
    params: { team },
  }),
  resolveAccessRequest: (
    teamId: string,
    requestId: string,
    decision: "approve" | "decline",
  ) => callApi(resolveTeamAccessRequestContract, {
    params: { teamId, requestId },
    body: { decision },
  }),
};
