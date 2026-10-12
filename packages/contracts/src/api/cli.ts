/**
 * The public CLI's sign-in and session. `shipbash login` files a pairing
 * request and polls for its token; the console shows the request to the
 * signed-in owner and takes the decision; a bearer token then names the
 * caller on every other route.
 */
import { z } from "zod";

import { PUBLIC_TEAM_MEMBERSHIPS_ROLE_VALUES } from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import { idSchema, timestampSchema } from "./primitives.ts";

/** Four-by-four, upper case, without the characters an eye confuses. */
export const cliPairingCodeSchema = z
	.string()
	.regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
const codeParamsSchema = z.object({ code: cliPairingCodeSchema }).strict();

export const cliLoginStateSchema = z.enum([
	"pending",
	"approved",
	"taken",
	"denied",
	"expired",
]);
export type CliLoginState = z.output<typeof cliLoginStateSchema>;

const cliClientSchema = z
	.object({
		name: z.string().trim().min(1).max(40),
		version: z.string().trim().min(1).max(40),
	})
	.strict();

export const cliLoginRequestSchema = z
	.object({
		code: cliPairingCodeSchema,
		state: cliLoginStateSchema,
		client: cliClientSchema,
		device: z.string(),
		expiresAt: timestampSchema,
	})
	.strict();
export type CliLoginRequest = z.output<typeof cliLoginRequestSchema>;

/** Filed by the CLI, before any sign-in: the request the owner will see. */
export const createCliLoginContract = defineApiContract({
	id: "cli.login.create",
	method: "POST",
	path: "/api/cli/sessions",
	params: null,
	query: null,
	body: z
		.object({
			client: cliClientSchema,
			device: z.string().trim().min(1).max(120),
		})
		.strict(),
	response: z
		.object({
			code: cliPairingCodeSchema,
			pollSecret: z.string(),
			expiresAt: timestampSchema,
			/** Where the owner approves it, relative to the API origin. */
			authorizePath: z.string(),
		})
		.strict(),
	successStatuses: [201],
});

/** The CLI's poll: pending until the owner decides, the token exactly once. */
export const collectCliTokenContract = defineApiContract({
	id: "cli.login.collect",
	method: "POST",
	path: "/api/cli/sessions/:code/token",
	params: codeParamsSchema,
	query: null,
	body: z.object({ pollSecret: z.string().min(1).max(200) }).strict(),
	response: z
		.object({
			state: cliLoginStateSchema,
			token: z.string().nullable(),
		})
		.strict(),
	successStatuses: [200],
});

/** What the console shows before the decision. */
export const getCliLoginContract = defineApiContract({
	id: "cli.login.get",
	method: "GET",
	path: "/api/cli/sessions/:code",
	params: codeParamsSchema,
	query: null,
	body: null,
	response: z.object({ request: cliLoginRequestSchema }).strict(),
	successStatuses: [200],
});

export const approveCliLoginContract = defineApiContract({
	id: "cli.login.approve",
	method: "POST",
	path: "/api/cli/sessions/:code/approve",
	params: codeParamsSchema,
	query: null,
	body: null,
	response: z.object({ request: cliLoginRequestSchema }).strict(),
	successStatuses: [200],
});

export const denyCliLoginContract = defineApiContract({
	id: "cli.login.deny",
	method: "POST",
	path: "/api/cli/sessions/:code/deny",
	params: codeParamsSchema,
	query: null,
	body: null,
	response: z.object({ request: cliLoginRequestSchema }).strict(),
	successStatuses: [200],
});

/** Who the presented token is, for `shipbash status`. */
export const cliSessionContract = defineApiContract({
	id: "cli.session.get",
	method: "GET",
	path: "/api/cli/session",
	params: null,
	query: null,
	body: null,
	response: z
		.object({
			user: z
				.object({
					id: idSchema,
					displayName: z.string(),
					/** Null for an account signed in with Google alone; it has an email instead. */
					githubLogin: z.string().nullable(),
					email: z.string().nullable(),
				})
				.strict(),
			teams: z.array(
				z
					.object({
						id: idSchema,
						slug: z.string(),
						name: z.string(),
						role: z.enum(PUBLIC_TEAM_MEMBERSHIPS_ROLE_VALUES),
					})
					.strict(),
			),
			token: z
				.object({
					client: cliClientSchema,
					device: z.string(),
					createdAt: timestampSchema,
				})
				.strict(),
		})
		.strict(),
	successStatuses: [200],
});

/** `shipbash logout`: the presented token stops working. */
export const revokeCliSessionContract = defineApiContract({
	id: "cli.session.revoke",
	method: "DELETE",
	path: "/api/cli/session",
	params: null,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
