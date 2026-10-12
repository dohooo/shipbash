import { z } from "zod";

import { PUBLIC_PROJECT_TRUSTED_ACCESS_STATUS_VALUES } from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import {
	idSchema,
	projectParamsSchema,
	timestampSchema,
} from "./primitives.ts";

export const trustedAccessViewSchema = z.object({
	projectId: idSchema,
	teamId: idSchema,
	mode: z.literal("cloudflare_header"),
	headerName: z.string(),
	status: z.enum(PUBLIC_PROJECT_TRUSTED_ACCESS_STATUS_VALUES),
	lastVerifiedAt: timestampSchema.nullable(),
	createdAt: timestampSchema,
	updatedAt: timestampSchema,
});

export const getTrustedAccessContract = defineApiContract({
	id: "trustedAccess.get",
	method: "GET",
	path: "/api/projects/:projectId/trusted-access",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({ trustedAccess: trustedAccessViewSchema.nullable() }),
	successStatuses: [200],
});

export const saveTrustedAccessContract = defineApiContract({
	id: "trustedAccess.save",
	method: "PUT",
	path: "/api/projects/:projectId/trusted-access",
	params: projectParamsSchema,
	query: null,
	body: z.object({
		mode: z.literal("cloudflare_header"),
		headerName: z
			.string()
			.trim()
			.toLowerCase()
			.pipe(z.literal("x-shipbash-access")),
		secret: z
			.string()
			.trim()
			.min(32)
			.max(4_096)
			.refine(
				(secret) =>
					[...secret].every((character) => {
						const codePoint = character.codePointAt(0) ?? 0;
						return codePoint > 0x1f && codePoint !== 0x7f;
					}),
				"secret must be a valid HTTP header value with at least 32 characters.",
			),
	}),
	response: z.object({ trustedAccess: trustedAccessViewSchema }),
	successStatuses: [200],
});

export const verifyTrustedAccessContract = defineApiContract({
	id: "trustedAccess.verify",
	method: "POST",
	path: "/api/projects/:projectId/trusted-access/verify",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({
		trustedAccess: trustedAccessViewSchema,
		verified: z.boolean(),
	}),
	successStatuses: [200],
});

export const deleteTrustedAccessContract = defineApiContract({
	id: "trustedAccess.delete",
	method: "DELETE",
	path: "/api/projects/:projectId/trusted-access",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
