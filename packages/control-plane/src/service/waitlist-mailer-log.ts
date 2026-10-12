/**
 * The waiting list's local mailer: it writes the message to the runner log
 * instead of sending it.
 *
 * A laptop has no Resend key and no verified sender, and the admission path is
 * still the one worth exercising end to end — the transaction, the membership
 * claim and the send all run, and the link the reader would have clicked is
 * printed where a developer can click it.
 */
import type { WaitlistMailer } from "../api/gateways.ts";
import { WAITLIST_ADMISSION_SUBJECT } from "../waitlist-email.ts";

/** `origin` is the console's, from the deployment's configuration. */
export function createLoggingWaitlistMailer(origin: string): WaitlistMailer {
	return {
		sendAdmission(input) {
			const signInUrl = new URL("/auth/login?next=%2F", origin).href;
			console.log(
				`[waitlist] to=${input.email} subject=${WAITLIST_ADMISSION_SUBJECT} site=${input.site} link=${signInUrl}`,
			);
			return Promise.resolve();
		},
	};
}
