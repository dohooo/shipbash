import { cookies } from "next/headers";
import { cache } from "react";

import {
	configuredWaitlistAdminPassword,
	WAITLIST_ADMIN_COOKIE,
	waitlistAdminSessionIsValid,
} from "../../../lib/waitlist-admin-session";

/**
 * The password, when this reader's cookie still proves they typed it.
 *
 * Read by the page that renders the list and again by the actions its buttons
 * post to, because a server action is a POST endpoint of its own: rendering
 * the button is not what authorizes pressing it.
 */
export const unlockedWaitlistAdminPassword = cache(
	async (): Promise<string | null> => {
		const password = configuredWaitlistAdminPassword();
		if (!password) return null;
		const cookie = (await cookies()).get(WAITLIST_ADMIN_COOKIE)?.value;
		return waitlistAdminSessionIsValid(cookie, password, Date.now())
			? password
			: null;
	},
);
