import {
	archiveProjectContract,
	updateProjectContract,
} from "@shipbash/contracts/api/projects";
import {
	parseBody,
	parseParams,
	sendContractJson,
} from "./contracts/server.ts";
import { matchRoute } from "./match-route.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext } from "./route-support.ts";
import { projectView } from "./views.ts";

async function handleUpdate(context: RouteContext): Promise<boolean> {
	const { request, response, actor, options } = context;
	const hit = matchRoute(context, updateProjectContract);
	if (!hit) return false;
	const { projectId } = parseParams(updateProjectContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const body = await parseBody(request, updateProjectContract.body);
	const project = await options.store.updateProject(actor, teamId, projectId, {
		productionUrl: body.productionUrl,
		...(body.testingContext === undefined
			? {}
			: { testingContext: body.testingContext }),
	});
	const repository = await options.store.getProjectRepository(
		actor,
		teamId,
		projectId,
	);
	sendContractJson(response, 200, updateProjectContract, {
		project: projectView(project, repository),
	});
	return true;
}

async function handleArchive(context: RouteContext): Promise<boolean> {
	const { response, actor, options } = context;
	const hit = matchRoute(context, archiveProjectContract);
	if (!hit) return false;
	const { projectId } = parseParams(archiveProjectContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const project = await options.store.archiveProject(actor, teamId, projectId);
	sendContractJson(response, 200, archiveProjectContract, {
		project: projectView(project, null),
	});
	return true;
}

export const handleProjectConfiguration = firstHandled(
	handleUpdate,
	handleArchive,
);
