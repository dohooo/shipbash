import {
	projectActivitiesContract,
	projectJourneysContract,
	projectOverviewContract,
	projectProposalsContract,
	projectVerificationsContract,
} from "@shipbash/contracts/api/projects";
import { parseParams, sendContractJson } from "./contracts/server.ts";
import type { StoreSuiteDetail } from "./gateways.ts";
import { matchRoute } from "./match-route.ts";
import { firstHandled } from "./route-handler.ts";
import type { RouteContext } from "./route-support.ts";
import { projectContext } from "./route-support.ts";
import {
	activityView,
	initialProposalIds,
	loadEditWalks,
	loadProposalViewInputs,
	proposalView,
	runView,
	suiteDetailView,
	suiteNameMap,
} from "./views.ts";

async function handleJourneys(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, projectJourneysContract);
	if (!hit) return false;
	const { response, actor, options } = context;
	const { projectId } = parseParams(projectJourneysContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const [summaries, proposals, initialIds] = await Promise.all([
		options.store.listSuiteSummaries(actor, teamId, projectId),
		options.store.listProposals(actor, teamId, projectId),
		initialProposalIds(options.store, actor, teamId, projectId),
	]);
	const details = await Promise.all(
		summaries.map((suite) =>
			options.store.getSuiteDetail(actor, teamId, projectId, suite.id),
		),
	);
	const live = details.filter((detail): detail is StoreSuiteDetail => detail !== null);
	const viewInputs = {
		suiteNames: suiteNameMap(summaries),
		initialIds,
		liveCases: new Map(live.map((detail) => [detail.suite.id, detail.cases])),
		editWalks: await loadEditWalks(options.store, actor, teamId, projectId, proposals),
	};
	sendContractJson(response, 200, projectJourneysContract, {
		suites: live.map(suiteDetailView),
		proposals: proposals.map((proposal) => proposalView(proposal, viewInputs)),
	});
	return true;
}

async function handleProposals(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, projectProposalsContract);
	if (!hit) return false;
	const { response, actor, options } = context;
	const { projectId } = parseParams(projectProposalsContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const proposals = await options.store.listProposals(actor, teamId, projectId);
	const viewInputs = await loadProposalViewInputs(options.store, actor, teamId, projectId, proposals);
	sendContractJson(response, 200, projectProposalsContract, {
		proposals: proposals.map((proposal) => proposalView(proposal, viewInputs)),
	});
	return true;
}

async function handleVerifications(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, projectVerificationsContract);
	if (!hit) return false;
	const { response, actor, options } = context;
	const { projectId } = parseParams(projectVerificationsContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const [runs, suites] = await Promise.all([
		options.store.listSuiteRuns(actor, teamId, projectId),
		options.store.listSuiteSummaries(actor, teamId, projectId),
	]);
	const suiteNames = suiteNameMap(suites);
	sendContractJson(response, 200, projectVerificationsContract, {
		runs: runs.map((run) => runView(run, suiteNames)),
	});
	return true;
}

async function handleActivities(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, projectActivitiesContract);
	if (!hit) return false;
	const { response, actor, options } = context;
	const { projectId } = parseParams(projectActivitiesContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const activities = await options.store.listActivities(
		actor,
		teamId,
		projectId,
	);
	sendContractJson(response, 200, projectActivitiesContract, {
		activities: activities.map(activityView),
	});
	return true;
}

async function handleOverview(context: RouteContext): Promise<boolean> {
	const hit = matchRoute(context, projectOverviewContract);
	if (!hit) return false;
	const { response, actor, options } = context;
	const { projectId } = parseParams(projectOverviewContract.params, hit.raw);
	const { teamId } = await projectContext(options.store, actor, projectId);
	const [overview, suites, authProfile] = await Promise.all([
		options.store.getOverviewAggregate(actor, teamId, projectId),
		options.store.listSuiteSummaries(actor, teamId, projectId),
		options.store.getProjectAuthProfile(actor, teamId, projectId),
	]);
	const suiteNames = suiteNameMap(suites);
	sendContractJson(response, 200, projectOverviewContract, {
		testCount: overview.testCount,
		runCount: overview.runCount,
		passingStreak: overview.passingStreak,
		recentRuns: overview.latestRuns
			.slice(0, 5)
			.map((run) => runView(run, suiteNames)),
		hasMoreRuns: overview.hasMoreRuns || overview.latestRuns.length > 5,
		authProfile,
	});
	return true;
}

export const handleProjectResources = firstHandled(
	handleJourneys,
	handleProposals,
	handleVerifications,
	handleActivities,
	handleOverview,
);
