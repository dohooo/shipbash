import { z } from "zod";
import { defineApiContract } from "./core.ts";
import { projectParamsSchema, timestampSchema } from "./primitives.ts";

const params = projectParamsSchema.extend({ signInId: z.uuid() });
const path = "/api/projects/:projectId/sign-ins/:signInId/authenticator";
export const githubAccountLoginSchema = z
	.string()
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/u);
export const authenticatorViewSchema = z.object({
	accountLogin: githubAccountLoginSchema,
});
const response = z.object({
	authenticator: authenticatorViewSchema.nullable(),
	accountLogin: githubAccountLoginSchema.nullable(),
});
export const readGitHubAuthenticatorContract = defineApiContract({
	id: "authenticators.read",
	method: "GET",
	path,
	params,
	query: null,
	body: null,
	response,
	successStatuses: [200],
});
/** Admin-only, transient code display. The setup secret never leaves the service. */
export const readGitHubAuthenticatorCodeContract = defineApiContract({
  id: "authenticators.code",
  method: "GET",
  path: `${path}/code`,
  params,
  query: null,
  body: null,
  response: z.object({ code: z.string().regex(/^\d{6}$/u), serverTime: timestampSchema, expiresAt: timestampSchema }),
  successStatuses: [200],
});
export const saveGitHubAuthenticatorContract = defineApiContract({
	id: "authenticators.save",
	method: "PUT",
	path,
	params,
	query: null,
	body: z.object({
		secret: z.string().trim().min(1).max(4096),
	}),
	response,
	successStatuses: [200],
});
export const removeGitHubAuthenticatorContract = defineApiContract({
	id: "authenticators.remove",
	method: "DELETE",
	path,
	params,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
export const authAttentionItemSchema = z.object({
	id: z.uuid(),
	runId: z.string(),
	caseRunId: z.string(),
	signInId: z.uuid().nullable(),
	accountLogin: z.string().nullable(),
	reason: z.string(),
	message: z.string(),
	status: z.enum(["open", "resolved"]),
	createdAt: timestampSchema,
	resolvedAt: timestampSchema.nullable(),
});
export const authAttentionContract = defineApiContract({
	id: "authenticators.attention",
	method: "GET",
	path: "/api/projects/:projectId/auth-attention",
	params: projectParamsSchema,
	query: z.object({ runId: z.string().max(200).optional() }),
	body: null,
	response: z.object({ items: z.array(authAttentionItemSchema) }),
	successStatuses: [200],
});
