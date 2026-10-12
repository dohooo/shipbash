/**
 * Signing in to the Project's own product by hand, before any discovery
 * exists. The browser is the Project's, not an Activity's, so the takeover
 * verbs hang off the Project.
 */
import { z } from "zod";

import { defineApiContract } from "./core.ts";
import { projectParamsSchema } from "./primitives.ts";
import { teamSignInMethodSchema } from "./sign-ins.ts";

export const signInTakeoverGrantSchema = z.object({
	/** The takeover browser's screencast endpoint, checked again by safeBrowserStreamUrl. */
	streamUrl: z.string().min(1),
	/** The control lease the canvas presents to claim input over that stream. */
	controlToken: z.string().min(1),
});
export type SignInTakeoverGrant = z.output<typeof signInTakeoverGrantSchema>;

export const startSignInTakeoverContract = defineApiContract({
	id: "signInTakeover.start",
	method: "POST",
	path: "/api/projects/:projectId/sign-ins/takeover",
	params: projectParamsSchema,
	query: null,
	/**
	 * The way in being added. A third-party method opens on the provider's own
	 * sign-in page; the product's own methods, or no method, open the product.
	 */
	body: z.object({ method: teamSignInMethodSchema.nullable().optional() }),
	response: signInTakeoverGrantSchema,
	successStatuses: [200],
});

export const releaseSignInTakeoverContract = defineApiContract({
	id: "signInTakeover.release",
	method: "POST",
	path: "/api/projects/:projectId/sign-ins/takeover/release",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
