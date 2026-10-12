import { z } from "zod";

import {
	PUBLIC_PROJECT_REPOSITORIES_ACCESS_STATUS_VALUES,
	PUBLIC_PROJECTS_LIFECYCLE_STATUS_VALUES,
	PUBLIC_TARGET_AUTH_PROFILES_STATUS_VALUES,
} from "../runtime/generated/db-vocabularies.mjs";
import { activityViewSchema } from "./activities.ts";
import { defineApiContract } from "./core.ts";
import { journeyDetailSchema, runViewSchema } from "./journeys.ts";
import {
	agentRuntimeSchema,
	idSchema,
	nonEmptyTextSchema,
	nullableTimestampSchema,
	optionalTextSchema,
	projectParamsSchema,
	teamParamsSchema,
} from "./primitives.ts";
import { productionUrlSchema } from "./production-url.ts";
import { proposalViewSchema } from "./proposals.ts";

export const projectRepositoryViewSchema = z.object({
	id: idSchema,
	githubRepositoryId: z.number().int().positive(),
	ownerLogin: z.string(),
	repositoryName: z.string(),
	defaultBranch: z.string(),
	selectedCommitSha: z.string().nullable(),
	accessStatus: z.enum(PUBLIC_PROJECT_REPOSITORIES_ACCESS_STATUS_VALUES),
});

export const projectViewSchema = z.object({
	id: idSchema,
	teamId: idSchema,
	slug: z.string(),
	name: z.string(),
	productionUrl: z.string().nullable(),
	testingContext: z.string().nullable(),
	agentRuntime: agentRuntimeSchema,
	lifecycleStatus: z.enum(PUBLIC_PROJECTS_LIFECYCLE_STATUS_VALUES),
	repository: projectRepositoryViewSchema.nullable(),
});

const authProfileSchema = z.object({
	status: z.enum(PUBLIC_TARGET_AUTH_PROFILES_STATUS_VALUES),
	productionOrigin: z.string(),
	lastVerifiedAt: nullableTimestampSchema,
	failureReason: z.string().nullable(),
});

const createProjectBodySchema = z.object({
	productionUrl: productionUrlSchema,
	agentRuntime: agentRuntimeSchema.nullable().optional(),
	/** One per intent to create a Project: a request that repeats it gets the Project the first one created. */
	clientIdempotencyKey: nonEmptyTextSchema(200),
});

export const createProjectContract = defineApiContract({
	id: "projects.create",
	method: "POST",
	path: "/api/teams/:teamId/projects",
	params: teamParamsSchema,
	query: null,
	body: createProjectBodySchema,
	response: z.object({ project: projectViewSchema }),
	successStatuses: [201],
});

export const updateProjectContract = defineApiContract({
	id: "projects.update",
	method: "PATCH",
	path: "/api/projects/:projectId",
	params: projectParamsSchema,
	query: null,
	body: z.object({
		productionUrl: productionUrlSchema,
		testingContext: optionalTextSchema(4_000),
	}),
	response: z.object({ project: projectViewSchema }),
	successStatuses: [200],
});

export const archiveProjectContract = defineApiContract({
	id: "projects.archive",
	method: "DELETE",
	path: "/api/projects/:projectId",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({ project: projectViewSchema }),
	successStatuses: [200],
});

export const projectOverviewContract = defineApiContract({
	id: "projects.overview",
	method: "GET",
	path: "/api/projects/:projectId/overview",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({
		testCount: z.number().int().nonnegative(),
		runCount: z.number().int().nonnegative(),
		passingStreak: z.number().int().nonnegative(),
		recentRuns: z.array(runViewSchema),
		hasMoreRuns: z.boolean(),
		authProfile: authProfileSchema.nullable(),
	}),
	successStatuses: [200],
});

export const projectJourneysContract = defineApiContract({
	id: "projects.journeys",
	method: "GET",
	path: "/api/projects/:projectId/journeys",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({
		suites: z.array(journeyDetailSchema),
		proposals: z.array(proposalViewSchema),
	}),
	successStatuses: [200],
});

export const projectProposalsContract = defineApiContract({
	id: "projects.proposals",
	method: "GET",
	path: "/api/projects/:projectId/proposals",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({ proposals: z.array(proposalViewSchema) }),
	successStatuses: [200],
});

export const projectVerificationsContract = defineApiContract({
	id: "projects.verifications",
	method: "GET",
	path: "/api/projects/:projectId/verifications",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({ runs: z.array(runViewSchema) }),
	successStatuses: [200],
});

export const projectActivitiesContract = defineApiContract({
	id: "projects.activities",
	method: "GET",
	path: "/api/projects/:projectId/activities",
	params: projectParamsSchema,
	query: null,
	body: null,
	response: z.object({ activities: z.array(activityViewSchema) }),
	successStatuses: [200],
});
