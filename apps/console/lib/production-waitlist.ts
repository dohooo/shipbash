import "server-only";

import type { ApiOptions } from "@shipbash/control-plane/api";
import { createResendWaitlistMailer } from "@shipbash/control-plane/waitlist-mailer";

import type { ProductionRuntimeResources } from "./production-resources";

/** Built once for the lambda rather than once per request. */
let mailer: ApiOptions["waitlistMailer"];

function waitlistMailer(resources: ProductionRuntimeResources): ApiOptions["waitlistMailer"] {
	const { email } = resources.configuration.integrations;
	if (email) mailer ??= createResendWaitlistMailer(email, resources.publicBaseUrl);
	return mailer;
}

/**
 * Everything the internal waiting list needs from production, and nothing
 * else.
 *
 * It is its own options object rather than the ordinary one with a hole in it,
 * because there is no account behind the shared password and every other
 * gateway the API serves needs a person. Spelling out the three doors it may
 * open is what keeps it from ever reaching one that cannot answer.
 *
 * Either seam absent, that lane answers 503 rather than half-working: no
 * password is no way in, and no mailer is no way to keep the promise admission
 * makes, which is why an admission that cannot send is refused outright
 * instead of being recorded and forgotten.
 */
export function waitlistAdminApiOptions(resources: ProductionRuntimeResources): ApiOptions {
	const password = resources.configuration.integrations.waitlistAdminPassword;
	const sender = waitlistMailer(resources);
	return {
		store: resources.store.actor,
		internal: resources.store.internal,
		actorSigningSecret: resources.actorSigningSecret,
		publicBaseUrl: resources.publicBaseUrl,
		...(password ? { waitlistAdminPassword: password } : {}),
		...(sender ? { waitlistMailer: sender } : {}),
	};
}
