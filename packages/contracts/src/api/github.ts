import { z } from "zod";

import { PUBLIC_GITHUB_INSTALLATIONS_ACCOUNT_TYPE_VALUES } from "../runtime/generated/db-vocabularies.mjs";
import { defineApiContract } from "./core.ts";
import {
	idSchema,
	nonEmptyTextSchema,
	teamParamsSchema,
	timestampSchema,
} from "./primitives.ts";

/** A repository an installation can read, named the way GitHub names it. */
const githubRepositorySchema = z.object({
	id: z.number().int().positive(),
	owner: z.string(),
	name: z.string(),
	defaultBranch: z.string(),
});

/**
 * The repository one project reads. `commitSha` and `lastReadAt` are the last
 * read's: the default branch's head when it was resolved, which every run
 * created since carries. `readable` turns false once the repository left
 * what the installation may read; the row is kept so the owner sees which.
 */
const githubBindingSchema = z.object({
	projectId: idSchema,
	/** Named here and not looked up: a project may be archived and still be bound. */
	projectName: z.string(),
	repository: githubRepositorySchema,
	commitSha: z.string().nullable(),
	lastReadAt: timestampSchema.nullable(),
	readable: z.boolean(),
});

/**
 * One GitHub account the team connected. `pending` waits for an organization
 * owner to approve the App; `revoked` is the connection with access taken
 * away on GitHub, bindings kept. `access` is what the installation may read,
 * read live; null when GitHub could not say.
 */
const githubConnectionSchema = z.object({
	id: idSchema,
	login: z.string(),
	accountType: z.enum(PUBLIC_GITHUB_INSTALLATIONS_ACCOUNT_TYPE_VALUES),
	avatarUrl: z.string(),
	status: z.enum(["pending", "connected", "revoked"]),
	/** Who connected it, as the team knows them; null when their profile is gone. */
	installedBy: z.string().nullable(),
	/** When the connect was started: the time an owner was asked, while pending. */
	requestedAt: timestampSchema,
	connectedAt: timestampSchema.nullable(),
	revokedAt: timestampSchema.nullable(),
	/** The installation's settings page on GitHub, where its repositories are chosen. */
	settingsUrl: z.string().nullable(),
	access: z
		.object({
			selection: z.enum(["all", "selected"]),
			count: z.number().int().nonnegative(),
		})
		.nullable(),
	bindings: z.array(githubBindingSchema),
});

export const teamGitHubConnectionsContract = defineApiContract({
	id: "github.connections",
	method: "GET",
	path: "/api/teams/:teamId/github",
	params: teamParamsSchema,
	query: null,
	body: null,
	response: z.object({ connections: z.array(githubConnectionSchema) }),
	successStatuses: [200],
});

/**
 * Where an admin's Connect goes: GitHub's install page, or — on a local
 * deployment with no App yet — the form that registers one from a manifest.
 */
export const githubInstallContract = defineApiContract({
	id: "github.install",
	method: "POST",
	path: "/api/teams/:teamId/github/install",
	params: teamParamsSchema,
	query: null,
	body: z.object({ returnPath: nonEmptyTextSchema(1_024) }),
	response: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("install_app"), url: z.string() }),
		z.object({
			kind: z.literal("register_app"),
			formAction: z.string(),
			manifest: z.string(),
		}),
	]),
	successStatuses: [200],
});

const githubConnectionParamsSchema = teamParamsSchema.extend({
	connectionId: idSchema,
});

/** The repositories one connection can read, asked of GitHub when a select opens. */
export const githubRepositoriesContract = defineApiContract({
	id: "github.repositories",
	method: "GET",
	path: "/api/teams/:teamId/github/connections/:connectionId/repositories",
	params: githubConnectionParamsSchema,
	query: null,
	body: null,
	response: z.object({
		repositories: z.array(githubRepositorySchema),
		/** GitHub has more than this pane will read; the reader is told rather than misled. */
		truncated: z.boolean(),
	}),
	successStatuses: [200],
});

/** Forgets the connection and every binding made through it; nothing changes on GitHub. */
export const disconnectGitHubContract = defineApiContract({
	id: "github.disconnect",
	method: "DELETE",
	path: "/api/teams/:teamId/github/connections/:connectionId",
	params: githubConnectionParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});

const githubBindingParamsSchema = teamParamsSchema.extend({ projectId: idSchema });

/** Chooses the repository a project reads, and reads it. */
export const bindGitHubRepositoryContract = defineApiContract({
	id: "github.bind",
	method: "PUT",
	path: "/api/teams/:teamId/github/bindings/:projectId",
	params: githubBindingParamsSchema,
	query: null,
	body: z.object({
		connectionId: idSchema,
		repositoryId: z.number().int().positive(),
	}),
	response: z.object({ binding: githubBindingSchema }),
	successStatuses: [200],
});

/** Reads the bound repository's default branch now. */
export const readGitHubRepositoryContract = defineApiContract({
	id: "github.read",
	method: "POST",
	path: "/api/teams/:teamId/github/bindings/:projectId/read",
	params: githubBindingParamsSchema,
	query: null,
	body: null,
	response: z.object({ binding: githubBindingSchema }),
	successStatuses: [200],
});

export const unbindGitHubRepositoryContract = defineApiContract({
	id: "github.unbind",
	method: "DELETE",
	path: "/api/teams/:teamId/github/bindings/:projectId",
	params: githubBindingParamsSchema,
	query: null,
	body: null,
	response: z.undefined(),
	successStatuses: [204],
});
