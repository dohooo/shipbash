/** Trusted Production header verification, storage, and clearing. */
import {
	parseBody,
	parseParams,
	sendContractJson,
	sendContractNoContent,
} from "./contracts/server.ts";
import {
	deleteTrustedAccessContract,
	getTrustedAccessContract,
	saveTrustedAccessContract,
	verifyTrustedAccessContract,
} from "@shipbash/contracts/api/trusted-access";
import { SignInCryptoError } from "../sign-in-crypto.ts";
import { matchRoute } from "./match-route.ts";
import { ApiError, requireConfigured } from "./http.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext, requireTeamAdmin } from "./route-support.ts";
import { projectTrustedAccessView } from "./views.ts";

const UNAVAILABLE_MESSAGE = "Trusted Production access is not configured.";

/**
 * The header is sealed under the deployment's sign-in keyring; a deployment
 * without that key, or without the key a row was sealed by, can neither save
 * nor open one. That is the operator's configuration, so it is answered as
 * unavailable, as a missing gateway is.
 */
function sealingUnavailable(error: unknown): never {
	if (error instanceof SignInCryptoError) {
		throw new ApiError(503, "TRUSTED_ACCESS_UNAVAILABLE", UNAVAILABLE_MESSAGE);
	}
	throw error;
}

async function handleVerification(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, verifyTrustedAccessContract);
	if (!hit) return false;
	const verify = requireConfigured(
		options.verifyTrustedAccess,
		"TRUSTED_ACCESS_UNAVAILABLE",
		UNAVAILABLE_MESSAGE,
	);
	const { projectId } = parseParams(verifyTrustedAccessContract.params, hit.raw);
	const { project, teamId, teamRole } = await projectContext(
		options.store,
		actor,
		projectId,
	);
	requireTeamAdmin(teamRole, "Only a Team Admin may verify Trusted Production access.");
	if (!project.productionUrl) {
		throw new ApiError(
			409,
			"PRODUCTION_URL_REQUIRED",
			"Set a Production URL before verifying Trusted Production access.",
		);
	}
	const access = await options.internal
		.openProjectTrustedAccessInternal({ teamId, projectId })
		.catch(sealingUnavailable);
	if (!access) {
		throw new ApiError(
			404,
			"TRUSTED_ACCESS_NOT_FOUND",
			"Trusted Production access was not found.",
		);
	}
	const verification = await verify({
		productionUrl: project.productionUrl,
		headerName: access.headerName,
		headerValue: access.headerValue,
	});
	const updated = await options.store.updateProjectTrustedAccessVerification(
		actor,
		teamId,
		projectId,
		{
			verified: verification.verified,
			expectedSecretCiphertext: access.secretCiphertext,
			verifiedOrigin: new URL(project.productionUrl).origin,
		},
	);
	if (!updated) {
		throw new ApiError(
			409,
			"TRUSTED_ACCESS_CHANGED",
			"Trusted Production access changed while verification was in progress. Verify again.",
		);
	}
	sendContractJson(response, 200, verifyTrustedAccessContract, {
		trustedAccess: projectTrustedAccessView(updated),
		verified: verification.verified,
	});
	return true;
}

async function handleRead(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, getTrustedAccessContract);
	if (!hit) return false;
	const { projectId } = parseParams(getTrustedAccessContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const access = await options.store.getProjectTrustedAccess(
		actor,
		teamId,
		projectId,
	);
	sendContractJson(response, 200, getTrustedAccessContract, {
		trustedAccess: access ? projectTrustedAccessView(access) : null,
	});
	return true;
}

/** The shared PUT/DELETE preamble: an admin-gated mutation. */
async function trustedAccessMutation(
	context: RouteContext,
	contract: typeof saveTrustedAccessContract | typeof deleteTrustedAccessContract,
): Promise<{ projectId: string; teamId: string } | false> {
	const { actor, options } = context;
	const hit = matchRoute(context, contract);
	if (!hit) return false;
	const { projectId } = parseParams(contract.params, hit.raw);
	const { teamId, teamRole } = await projectContext(
		options.store,
		actor,
		projectId,
	);
	requireTeamAdmin(teamRole, "Only a Team Admin may manage Trusted Production access.");
	return { projectId, teamId };
}

async function handleSave(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const mutation = await trustedAccessMutation(context, saveTrustedAccessContract);
	if (!mutation) return false;
	const { projectId, teamId } = mutation;
	const { mode, headerName, secret } = await parseBody(
		request,
		saveTrustedAccessContract.body,
	);
	const saved = await options.store
		.upsertProjectTrustedAccess(actor, teamId, projectId, { mode, headerName, secret })
		.catch(sealingUnavailable);
	sendContractJson(response, 200, saveTrustedAccessContract, {
		trustedAccess: projectTrustedAccessView(saved),
	});
	return true;
}

async function handleDelete(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const mutation = await trustedAccessMutation(context, deleteTrustedAccessContract);
	if (!mutation) return false;
	await options.store.revokeProjectTrustedAccess(actor, mutation.teamId, mutation.projectId);
	sendContractNoContent(response, 204, deleteTrustedAccessContract);
	return true;
}

export const handleTrustedAccess = firstHandled(
	handleVerification,
	handleRead,
	handleSave,
	handleDelete,
);
