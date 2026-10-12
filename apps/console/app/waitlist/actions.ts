"use server";

import { redirect } from "next/navigation";

import { joinWaitlist } from "../../lib/waitlist-client";
import type { JoinWaitlistState } from "./waitlist-state";

function field(form: FormData, name: string): string {
	const value = form.get(name);
	return typeof value === "string" ? value.trim() : "";
}

/**
 * The whole verdict is the server's. The form carries `type="url"` and
 * `required` as hints, but a reader with scripting off has to get the same
 * answer, so nothing here trusts that they ran.
 */
export async function joinWaitlistAction(
	previous: JoinWaitlistState,
	form: FormData,
): Promise<JoinWaitlistState> {
	const email = field(form, "email");
	const site = field(form, "site");
	const answered = { attempt: previous.attempt + 1, email, site };
	if (!email || !site) {
		return {
			...answered,
			error: "other",
			message: "Both an address and a site are needed.",
		};
	}
	const failure = await joinWaitlist({ email, site });
	// The ask landed. Re-reading the page is what turns it into the receipt.
	if (!failure) redirect("/waitlist");
	return {
		...answered,
		error: failure.code === "INVALID_SITE" ? "site" : "other",
		message: failure.message,
	};
}
