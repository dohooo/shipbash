/**
 * Finishing a sign-in by hand, and watching the check that decides it.
 *
 * "I'm done" saves nothing on the person's word. It captures the session the
 * takeover browser holds and starts a verification leg, so the answer here is
 * a sign-in that is `verifying` — never one that is already ready. The ticked
 * state, and the account label on it, arrive later from the leg, which is
 * what the reading contract is for.
 *
 * A saved sign-in already on the list is checked again through a door of its
 * own. For a saved email and password that door is `Save and verify`, which
 * types the credential into the product's login page; for every other method
 * it re-opens the product with the session already kept, so a way in that has
 * stopped working is proved on the row it is stored on rather than on a new
 * one. The answer is the same shape and the same promise — `verifying`, and
 * the leg decides.
 */
import { z } from "zod";

import { defineApiContract } from "./core.ts";
import { idSchema, nullableTimestampSchema, projectParamsSchema } from "./primitives.ts";
import {
	teamSignInFailureReasonSchema,
	teamSignInMethodSchema,
	teamSignInStatusSchema,
} from "./sign-ins.ts";

/**
 * The methods this route can finish: every one where the person signs in and
 * ShipBash keeps the session. Email and password is not one of them — nobody
 * signs in by hand for it, so it is saved and verified through its own door.
 */
export const sessionSignInMethodSchema = teamSignInMethodSchema.exclude([
	"email_password",
]);

/** One sign-in as a page may see it: the card's facts, and nothing sealed. */
export const projectSignInSchema = z.object({
	id: idSchema,
	method: teamSignInMethodSchema,
	/** Read back by the verification leg from the signed-in product, never typed. */
	label: z.string().nullable(),
	status: teamSignInStatusSchema,
	failureReason: teamSignInFailureReasonSchema.nullable(),
	consecutiveFailures: z.number().int().nonnegative(),
	lastVerifiedAt: nullableTimestampSchema,
});

export const signInVerificationSchema = z.object({
	status: teamSignInStatusSchema,
	/** The leg's screencast while it runs, checked again by safeBrowserStreamUrl; null otherwise. */
	streamUrl: z.string().min(1).nullable(),
	failureReason: teamSignInFailureReasonSchema.nullable(),
	label: z.string().nullable(),
});

export const completeSignInTakeoverContract = defineApiContract({
	id: "signInVerification.complete",
	method: "POST",
	path: "/api/projects/:projectId/sign-ins/takeover/complete",
	params: projectParamsSchema,
	query: null,
	body: z.object({
		method: sessionSignInMethodSchema,
		/**
		 * The saved way in the person signed in to again, which keeps the session
		 * on its own row; a new way in has none, and gets a row of its own.
		 */
		signInId: idSchema.optional(),
	}),
	response: z.object({ signIn: projectSignInSchema }),
	// Accepted, not done: the leg that decides is still running.
	successStatuses: [202],
});

export const verifySignInContract = defineApiContract({
	id: "signInVerification.verify",
	method: "POST",
	path: "/api/projects/:projectId/sign-ins/:signInId/verify",
	params: projectParamsSchema.extend({ signInId: idSchema }),
	query: null,
	body: null,
	response: z.object({ signIn: projectSignInSchema }),
	// Accepted, not done: the browser proving this sign-in is still running.
	successStatuses: [202],
});

export const readSignInVerificationContract = defineApiContract({
	id: "signInVerification.read",
	method: "GET",
	path: "/api/projects/:projectId/sign-ins/:signInId/verification",
	params: projectParamsSchema.extend({ signInId: idSchema }),
	query: null,
	body: null,
	response: signInVerificationSchema,
	successStatuses: [200],
});
