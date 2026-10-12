/**
 * Sending the waiting list's one email, through Resend.
 *
 * `sendAdmission` is awaited inside the admitting transaction, so throwing
 * here is not a dropped message: it takes the admission back with it, and the
 * internal list still shows the row as waiting. That is the behaviour worth
 * protecting — somebody marked as let in who was never told is the failure
 * nobody notices.
 */
import { Resend } from "resend";

import { WaitlistMailError, type WaitlistMailer } from "./api/gateways.ts";
import type { EmailIntegration } from "./configuration.ts";
import { renderWaitlistAdmissionEmail } from "./waitlist-email.ts";

/** The copy names a host, not the whole address they typed. */
function siteHost(site: string): string {
	try {
		return new URL(site).host;
	} catch {
		return site;
	}
}

/** Sends from the deployment's verified sender (SHIPBASH_EMAIL_FROM), linking to the console at `origin`. */
export function createResendWaitlistMailer(email: EmailIntegration, origin: string): WaitlistMailer {
	const resend = new Resend(email.resendApiKey);
	return {
		async sendAdmission(input) {
			const message = renderWaitlistAdmissionEmail({
				siteHost: siteHost(input.site),
				accountEmail: input.email,
				signInUrl: new URL("/auth/login?next=%2F", origin).href,
				markUrl: new URL("/shipbash-eye-mark.png", origin).href,
			});
			const { error } = await resend.emails.send({
				from: email.from,
				to: [input.email],
				subject: message.subject,
				html: message.html,
				text: message.text,
			});
			if (error) {
				throw new WaitlistMailError(
					`Resend refused the message: ${error.message}`,
				);
			}
		},
	};
}
