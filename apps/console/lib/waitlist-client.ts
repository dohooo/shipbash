import "server-only";

import {
	apiContractPath,
	apiErrorSchema,
	decideWaitlistRequestContract,
	joinWaitlistContract,
	listTeamUsageContract,
	listWaitlistRequestsContract,
	setTeamRunQuotaContract,
} from "./api-contracts";
import { proxyRunnerRequest, proxyWaitlistAdminRequest } from "./runner-proxy";
import { configuration } from "./server-contracts";

/** The API's own verdict, kept as a code so the page can word it itself. */
interface WaitlistFailure {
	code: string;
	message: string;
}

export type WaitlistRequestView = ReturnType<
	typeof listWaitlistRequestsContract.response.parse
>["requests"][number];

const UNAVAILABLE: WaitlistFailure = {
	code: "UNAVAILABLE",
	message: "The waiting list is temporarily unavailable.",
};

async function failureOf(response: Response): Promise<WaitlistFailure> {
	const parsed = apiErrorSchema.safeParse(
		await response.json().catch(() => null),
	);
	return parsed.success
		? { code: parsed.data.error, message: parsed.data.message }
		: UNAVAILABLE;
}

/** Null when the ask landed. */
export async function joinWaitlist(input: {
	email: string;
	site: string;
}): Promise<WaitlistFailure | null> {
	const origin = configuration().publicUrl;
	const response = await proxyRunnerRequest(
		new Request(new URL(joinWaitlistContract.path, origin), {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify(input),
		}),
		joinWaitlistContract.path,
	);
	if (response.status === 201) {
		await response.body?.cancel();
		return null;
	}
	return failureOf(response);
}

/**
 * Throws rather than answering with the failure, unlike the two writes: a list
 * that cannot be read has no page to render the problem onto, so it belongs in
 * the error boundary.
 */
export async function listWaitlistRequests(
	password: string,
): Promise<WaitlistRequestView[]> {
	const response = await proxyWaitlistAdminRequest(
		listWaitlistRequestsContract.path,
		{ method: "GET" },
		password,
	);
	if (!response.ok) throw new Error((await failureOf(response)).message);
	return listWaitlistRequestsContract.response.parse(await response.json())
		.requests;
}

export type TeamUsageView = ReturnType<
	typeof listTeamUsageContract.response.parse
>["teams"][number];

/** Every team's usage this month. Throws, like the list, for the error boundary. */
export async function listTeamUsage(
	password: string,
): Promise<TeamUsageView[]> {
	const response = await proxyWaitlistAdminRequest(
		listTeamUsageContract.path,
		{ method: "GET" },
		password,
	);
	if (!response.ok) throw new Error((await failureOf(response)).message);
	return listTeamUsageContract.response.parse(await response.json()).teams;
}

/** A team's monthly Run quota; null is no limit. Null when it was saved. */
export async function setTeamRunQuota(
	password: string,
	teamId: string,
	monthlyRunQuota: number | null,
): Promise<WaitlistFailure | null> {
	const response = await proxyWaitlistAdminRequest(
		apiContractPath(setTeamRunQuotaContract, {
			params: { teamId },
			body: { monthlyRunQuota },
		}),
		{ method: "PATCH", body: JSON.stringify({ monthlyRunQuota }) },
		password,
	);
	if (response.status === 204) {
		await response.body?.cancel();
		return null;
	}
	return failureOf(response);
}

export async function decideWaitlistRequest(
	password: string,
	userId: string,
	action: "shelve" | "unshelve" | "admit",
): Promise<WaitlistFailure | null> {
	const response = await proxyWaitlistAdminRequest(
		apiContractPath(decideWaitlistRequestContract, {
			params: { userId },
			body: { action },
		}),
		{ method: "PATCH", body: JSON.stringify({ action }) },
		password,
	);
	if (response.status === 204) {
		await response.body?.cancel();
		return null;
	}
	return failureOf(response);
}
