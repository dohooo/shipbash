import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "@shipbash/contracts/model-contract";
import { createProjectContract } from "@shipbash/contracts/api/projects";
import {
	parseBody,
	parseParams,
	sendContractJson,
} from "./contracts/server.ts";
import { projectNameFromProductionUrl } from "./http.ts";
import { matchRoute } from "./match-route.ts";
import type { RouteContext } from "./route-support.ts";
import { projectView } from "./views.ts";

async function createUrlProject(
	context: RouteContext,
	teamId: string,
	input: { productionUrl: string; agentRuntime: AgentRuntime; clientIdempotencyKey: string },
): Promise<void> {
	const { response, actor, options } = context;
	const project = await options.store.createUrlProject(actor, teamId, {
		id: randomUUID(),
		name: projectNameFromProductionUrl(input.productionUrl),
		productionUrl: input.productionUrl,
		agentRuntime: input.agentRuntime,
		clientIdempotencyKey: input.clientIdempotencyKey,
	});
	sendContractJson(response, 201, createProjectContract, {
		project: projectView(project, null),
	});
}

export async function handleProjectCreate(
	context: RouteContext,
): Promise<boolean> {
	const { request } = context;
	const hit = matchRoute(context, createProjectContract);
	if (!hit) return false;
	const { teamId } = parseParams(createProjectContract.params, hit.raw);
	const body = await parseBody(request, createProjectContract.body);
	await createUrlProject(context, teamId, {
		productionUrl: body.productionUrl,
		agentRuntime: body.agentRuntime ?? "pi",
		clientIdempotencyKey: body.clientIdempotencyKey,
	});
	return true;
}
