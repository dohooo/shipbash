"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { setTeamRunQuotaContract } from "../../../lib/api-contracts";
import { configuration, sameSecret } from "../../../lib/server-contracts";
import {
	configuredWaitlistAdminPassword,
	signWaitlistAdminSession,
	WAITLIST_ADMIN_COOKIE,
	WAITLIST_ADMIN_SESSION_MS,
} from "../../../lib/waitlist-admin-session";
import {
	decideWaitlistRequest,
	setTeamRunQuota,
} from "../../../lib/waitlist-client";
import { unlockedWaitlistAdminPassword } from "./unlocked";
import type { WaitlistAdminState } from "./waitlist-admin-state";

const HERE = "/internal/waitlist";
const UNCONFIGURED = "The internal waiting list is not configured.";
const EXPIRED = "This session has expired. Unlock again.";
const INVALID_QUOTA = "A quota is a whole number of Runs, or empty for no limit.";

export async function unlockWaitlistAdminAction(
	_previous: WaitlistAdminState,
	form: FormData,
): Promise<WaitlistAdminState> {
	const password = configuredWaitlistAdminPassword();
	if (!password) return { attempt: 0, error: UNCONFIGURED };
	const presented = form.get("password");
	if (typeof presented !== "string" || !sameSecret(presented, password)) {
		return { attempt: 0, error: "That is not the password." };
	}
	const expiresAtMs = Date.now() + WAITLIST_ADMIN_SESSION_MS;
	(await cookies()).set({
		name: WAITLIST_ADMIN_COOKIE,
		// Keyed by the password, so rotating it revokes every live session
		// without a table of them to sweep.
		value: signWaitlistAdminSession(password, expiresAtMs),
		httpOnly: true,
		sameSite: "lax",
		secure: configuration().publicUrl.startsWith("https:"),
		path: HERE,
		expires: new Date(expiresAtMs),
	});
	redirect(HERE);
}

export async function lockWaitlistAdminAction(): Promise<void> {
	(await cookies()).delete({ name: WAITLIST_ADMIN_COOKIE, path: HERE });
	redirect(HERE);
}

/**
 * Shelve, unshelve, or let someone in. A server action is a POST endpoint of
 * its own, so the cookie is proved here too rather than only by the page that
 * rendered the button.
 */
export async function decideWaitlistAction(
	previous: WaitlistAdminState,
	form: FormData,
): Promise<WaitlistAdminState> {
	const attempt = previous.attempt + 1;
	const password = await unlockedWaitlistAdminPassword();
	if (!password) return { attempt, error: EXPIRED };
	const userId = form.get("userId");
	const action = form.get("action");
	if (
		typeof userId !== "string" ||
		(action !== "shelve" && action !== "unshelve" && action !== "admit")
	) {
		return { attempt, error: "That is not something this page can do." };
	}
	const failure = await decideWaitlistRequest(password, userId, action);
	revalidatePath(HERE);
	return { attempt, error: failure?.message ?? null };
}

/**
 * A team's monthly Run quota, proved by the cookie here too, like a decision.
 * An empty field is no limit; anything else is held to the route's own body.
 */
export async function setTeamRunQuotaAction(
	previous: WaitlistAdminState,
	form: FormData,
): Promise<WaitlistAdminState> {
	const attempt = previous.attempt + 1;
	const password = await unlockedWaitlistAdminPassword();
	if (!password) return { attempt, error: EXPIRED };
	const teamId = form.get("teamId");
	const quota = form.get("quota");
	if (typeof teamId !== "string" || typeof quota !== "string") {
		return { attempt, error: INVALID_QUOTA };
	}
	const text = quota.trim();
	const body = setTeamRunQuotaContract.body.safeParse({
		monthlyRunQuota: text === "" ? null : Number(text),
	});
	if (!body.success) return { attempt, error: INVALID_QUOTA };
	const failure = await setTeamRunQuota(
		password,
		teamId,
		body.data.monthlyRunQuota,
	);
	revalidatePath(HERE);
	return { attempt, error: failure?.message ?? null };
}
