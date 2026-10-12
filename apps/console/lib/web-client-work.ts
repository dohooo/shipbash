import {
	answerActivityContract,
	cancelActivityContract,
	createActivityContract,
	retryActivityContract,
	steerActivityContract,
	stopActivityContract,
} from "@shipbash/contracts/api/activities";
import {
	cancelAuthContract,
	completeAuthContract,
	uploadAuthFileContract,
} from "@shipbash/contracts/api/auth";
import {
	deleteTrustedAccessContract,
	saveTrustedAccessContract,
	verifyTrustedAccessContract,
} from "@shipbash/contracts/api/trusted-access";
import type { ProjectTrustedAccessMode } from "@shipbash/contracts/database-contract-types";
import { callApi } from "./api-client";

export const workClient = {
	startDiscovery: (
		projectId: string,
		clientIdempotencyKey: string,
		message?: string | null,
	) =>
		callApi(createActivityContract, {
			params: { projectId },
			body: {
				kind: "initial_discovery",
				clientIdempotencyKey,
				...(message ? { message } : {}),
			},
		}),
	generateSuite: (
		projectId: string,
		message: string,
		targetSuiteId: string | null,
		clientIdempotencyKey: string,
	) =>
		callApi(createActivityContract, {
			params: { projectId },
			body: {
				kind: "generate_cases",
				message,
				targetSuiteId,
				clientIdempotencyKey,
			},
		}),
	cancelActivity: (projectId: string, activityId: string) =>
		callApi(cancelActivityContract, {
			params: { projectId, activityId },
		}),
	retryActivity: (
		projectId: string,
		activityId: string,
		clientIdempotencyKey: string,
	) =>
		callApi(retryActivityContract, {
			params: { projectId, activityId },
			body: { clientIdempotencyKey },
		}),
	answerActivityQuestion: (
		projectId: string,
		activityId: string,
		input: {
			questionId: string;
			option?: string;
			freeText?: string;
			note?: string;
			skipped?: boolean;
		},
	) =>
		callApi(answerActivityContract, {
			params: { projectId, activityId },
			body: input,
		}),
	steerActivity: (
		projectId: string,
		activityId: string,
		input: { message: string; clientKey: string },
	) =>
		callApi(steerActivityContract, {
			params: { projectId, activityId },
			body: input,
		}),
	stopActivity: (projectId: string, activityId: string) =>
		callApi(stopActivityContract, {
			params: { projectId, activityId },
		}),
	activityAuthUpload: (
		projectId: string,
		activityId: string,
		input: { name: string; dataBase64: string },
	) =>
		callApi(uploadAuthFileContract, {
			params: {
				projectId,
				targetCollection: "activities",
				targetId: activityId,
			},
			body: input,
		}),
	completeActivityAuth: (projectId: string, activityId: string) =>
		callApi(completeAuthContract, {
			params: {
				projectId,
				targetCollection: "activities",
				targetId: activityId,
			},
		}),
	cancelActivityAuth: (projectId: string, activityId: string) =>
		callApi(cancelAuthContract, {
			params: {
				projectId,
				targetCollection: "activities",
				targetId: activityId,
			},
		}),
	saveTrustedAccess: (
		projectId: string,
		input: {
			mode: ProjectTrustedAccessMode;
			headerName: string;
			secret: string;
		},
	) =>
		callApi(saveTrustedAccessContract, { params: { projectId }, body: input }),
	verifyTrustedAccess: (projectId: string) =>
		callApi(verifyTrustedAccessContract, {
			params: { projectId },
		}),
	removeTrustedAccess: (projectId: string) =>
		callApi(deleteTrustedAccessContract, {
			params: { projectId },
		}),
};
