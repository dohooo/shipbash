import { GitHubAppUnavailableError } from "../github-tenant-service.ts";
import {
	issueTeamInvitationToken,
	teamInvitationPath,
} from "../team-invitations.ts";
import {
	createInvitationContract,
	removeTeamMemberContract,
	revokeInvitationContract,
	teamMembersContract,
	teamRunAllowanceContract,
	teamRunDaysContract,
	updateTeamMemberContract,
} from "@shipbash/contracts/api/account";
import {
	parseBody,
	parseParams,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, requireConfigured } from "./http.ts";
import type { RouteContext } from "./route-support.ts";

export async function handleMembers(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, teamMembersContract);
	if (!hit) return false;
	const { teamId } = parseParams(teamMembersContract.params, hit.raw);
	sendContractJson(response, 200, teamMembersContract, {
		members: await options.store.listTeamMembers(actor, teamId),
		invitations: await options.store.listTeamInvitations(actor, teamId),
		accessRequests: await options.store.listTeamAccessRequests(actor, teamId),
	});
	return true;
}

export async function handleRunAllowance(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, teamRunAllowanceContract);
	if (!hit) return false;
	const { teamId } = parseParams(teamRunAllowanceContract.params, hit.raw);
	const allowance = await options.store.readRunAllowance(actor, teamId);
	if (!allowance) throw new ApiError(404, "TEAM_NOT_FOUND", "Team was not found.");
	sendContractJson(response, 200, teamRunAllowanceContract, allowance);
	return true;
}

export async function handleRunDays(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, teamRunDaysContract);
	if (!hit) return false;
	const { teamId } = parseParams(teamRunDaysContract.params, hit.raw);
	const days = await options.store.readRunDays(actor, teamId);
	if (!days) throw new ApiError(404, "TEAM_NOT_FOUND", "Team was not found.");
	sendContractJson(response, 200, teamRunDaysContract, { days });
	return true;
}

export async function handleCreateInvitation(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, createInvitationContract);
	if (!hit) return false;
	const github = requireConfigured(
		options.github,
		"GITHUB_UNAVAILABLE",
		"GitHub identity lookup is unavailable.",
	);
	const { teamId } = parseParams(createInvitationContract.params, hit.raw);
	const { githubLogin } = await parseBody(
		request,
		createInvitationContract.body,
	);
	const resolved = await github.resolveUser(githubLogin).catch((error) => {
		// The App the lookup needs is missing on this deployment: a typed
		// answer the Team page can show, not an unhandled 500.
		if (error instanceof GitHubAppUnavailableError) {
			throw new ApiError(
				503,
				"GITHUB_UNAVAILABLE",
				"Inviting by GitHub username needs the GitHub App configured for this deployment.",
			);
		}
		throw error;
	});
	const issued = issueTeamInvitationToken();
	const invitation = await options.store.createInvitation(actor, teamId, {
		githubUserId: resolved.id,
		githubLogin: resolved.login,
		tokenHash: issued.tokenHash,
		expiresAt: issued.expiresAt,
	});
	const inviteUrl = new URL(
		teamInvitationPath(issued.token),
		options.publicBaseUrl,
	).toString();
	sendContractJson(response, 201, createInvitationContract, {
		invitation,
		inviteUrl,
	});
	return true;
}

export async function handleRevokeInvitation(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, revokeInvitationContract);
	if (!hit) return false;
	const { teamId, invitationId } = parseParams(revokeInvitationContract.params, hit.raw);
	await options.store.revokeInvitation(actor, teamId, invitationId);
	sendContractNoContent(response, 204, revokeInvitationContract);
	return true;
}

export async function handleMemberMutation(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, updateTeamMemberContract, removeTeamMemberContract);
	if (!hit) return false;
	if (request.method === "PATCH") {
		const { teamId, userId } = parseParams(updateTeamMemberContract.params, hit.raw);
		const { role } = await parseBody(request, updateTeamMemberContract.body);
		await options.store.setTeamMemberRole(actor, teamId, userId, role);
		const member = (await options.store.listTeamMembers(actor, teamId)).find(
			(entry) => entry.userId === userId,
		);
		sendContractJson(response, 200, updateTeamMemberContract, { member });
		return true;
	}
	const { teamId, userId } = parseParams(removeTeamMemberContract.params, hit.raw);
	await options.store.removeTeamMember(actor, teamId, userId);
	sendContractNoContent(response, 204, removeTeamMemberContract);
	return true;
}
