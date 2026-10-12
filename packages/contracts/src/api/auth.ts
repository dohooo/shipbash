import { z } from "zod";

import { defineApiContract } from "./core.ts";
import {
	idSchema,
	nonEmptyTextSchema,
	projectParamsSchema,
} from "./primitives.ts";

export const authTargetParamsSchema = projectParamsSchema.extend({
	targetCollection: z.enum(["runs", "verifications", "activities"]),
	targetId: idSchema,
});

const authStatusResponseSchema = z.object({
	waiting: z.boolean(),
	authViewerUrl: z.string().nullable(),
	controlToken: z.string().nullable().optional(),
	resumed: z.boolean().optional(),
});

const authCompleteResponseSchema = z.object({
	resumed: z.boolean(),
	waiting: z.boolean().optional(),
	authViewerUrl: z.string().nullable().optional(),
});

export const authStatusContract = defineApiContract({
	id: "getAuthStatus",
	method: "GET",
	path: "/api/projects/:projectId/:targetCollection/:targetId/auth/status",
	params: authTargetParamsSchema,
	query: null,
	body: null,
	response: authStatusResponseSchema,
	successStatuses: [200],
});

export const completeAuthContract = defineApiContract({
	id: "completeAuth",
	method: "POST",
	path: "/api/projects/:projectId/:targetCollection/:targetId/auth/complete",
	params: authTargetParamsSchema,
	query: null,
	body: null,
	response: authCompleteResponseSchema,
	successStatuses: [200],
});

export const cancelAuthContract = defineApiContract({
	id: "cancelAuth",
	method: "POST",
	path: "/api/projects/:projectId/:targetCollection/:targetId/auth/cancel",
	params: authTargetParamsSchema,
	query: null,
	body: null,
	response: z.object({ canceled: z.literal(true) }),
	successStatuses: [200],
});

export const uploadAuthFileContract = defineApiContract({
	id: "uploadAuthFile",
	method: "POST",
	path: "/api/projects/:projectId/:targetCollection/:targetId/auth/upload",
	params: authTargetParamsSchema,
	query: null,
	body: z.object({
		name: nonEmptyTextSchema(200),
		dataBase64: nonEmptyTextSchema(12 * 1_024 * 1_024),
	}),
	response: z.object({ name: nonEmptyTextSchema(200) }),
	successStatuses: [200],
});
