"use client";

/**
 * Everything the report reads and everything it can do, in one hook.
 *
 * The page itself is then only the shell and where each part goes — which is
 * the point: the report IS the run page in its third state, so its component
 * should be able to say so in one screen without the run's two side queries,
 * its mutation and its clipboard work in the way.
 */

import type { RunCaseView, RunEventView, RunPageView } from "@shipbash/contracts/api/view-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { readKey } from "../../lib/queries";
import { rerunVerification } from "../../lib/run-control-client";
import { readQueryWhen, useIntentKey, webClient } from "../../lib/web-client";
import { buildReproPrompt, type HandoffVerdict } from "../_lib/repro-prompt";
import { earlierWalk, type RunShape, runShape } from "../_lib/run-report";
import { useArtifactPreview } from "./run-artifacts";
import { type RunReportModel, runReportModel } from "./run-report-model";
import { reproCopied } from "./handoff-button";
import { reportOpeningCase } from "./run-report-shell";
import type { SideSectionName, SideSections } from "./run-report-side";
import { useProduct } from "./shell";

interface RunReportState {
	artifactPreview: ReturnType<typeof useArtifactPreview>;
	/** Copies a settled walk's hand-off, its prompt picked by the walk's verdict. */
	handOff: (suiteCase: RunCaseView, verdict: HandoffVerdict) => Promise<boolean>;
	model: RunReportModel;
	rerun: (caseRunId: string) => void;
	/** Re-runs the whole suite this run walked, not a loop over its journeys. */
	rerunAll: () => void;
	rerunning: boolean;
	retryable: boolean;
	runFinished: boolean;
	selected: string | null;
	selectedCase: RunCaseView | null;
	setSelected: (caseRunId: string) => void;
	shape: RunShape;
	side: SideSections;
	/** The view the report is reading: the page's own, or the attempt a link named. */
	view: RunPageView;
}

/**
 * Which walk the URL asks for, and the view that shows it.
 *
 * `?journey=` names a Case Run, and the page it names is this one — so an
 * earlier walk is fetched as the same run read asked for that attempt, which
 * comes back with the row on that walk and marked as superseded. A link to a
 * walk the page's own view shows reads nothing more.
 */
function useShownView(
	view: RunPageView,
	runId: string,
): { focusCaseId: string | null; shown: RunPageView } {
	const { project } = useProduct();
	const focusCaseId = useSearchParams().get("journey");
	const walk = earlierWalk(view, focusCaseId);
	const attempt = useQuery(readQueryWhen("verification", walk ? [project.id, runId, walk] : null));
	return { focusCaseId, shown: attempt.data?.view ?? view };
}

/**
 * The whole suite again, through the endpoint that already exists for it — a
 * loop over runJourney would be several runs wearing one run's name.
 *
 * A press is one intent, and it keeps one key until the service has answered
 * it: a failed request pressed again asks for the same run, so the service
 * answers with the run it may already have queued rather than queuing another,
 * which the reader would pay for. An answered press spends it.
 */
function useRerunSuite(runId: string) {
	const router = useRouter();
	const { project, teamHref } = useProduct();
	const intent = useIntentKey();
	return useMutation({
		mutationFn: () => rerunVerification(project.id, runId, intent.key()),
		onSuccess: ({ run }) => {
			intent.spend();
			router.push(teamHref(`/verifications/${encodeURIComponent(run.id)}`));
		},
		onError: () => toast.error("The run could not be started again"),
	});
}

/**
 * One journey again. Re-running it stays on this page: the attempt is a new
 * run in the data, and this page is what shows the family — so the row goes
 * queued → running → its new verdict here, where the reader is looking.
 *
 * Each journey is its own intent, and keeps its key until the service answers.
 */
function useRerunJourney(runId: string) {
	const queryClient = useQueryClient();
	const { project } = useProduct();
	const journeyKeys = useIntentKey();
	return useMutation({
		mutationFn: (caseRunId: string) =>
			webClient.runJourney(project.id, runId, caseRunId, journeyKeys.key(caseRunId)),
		onSuccess: (_attempt, caseRunId) => {
			journeyKeys.spend(caseRunId);
			return queryClient.invalidateQueries({
				queryKey: readKey("verification", project.id, runId),
			});
		},
		onError: () => toast.error("The journey could not be re-run"),
	});
}

export function useRunReport(
	view: RunPageView,
	runId: string,
	log: readonly RunEventView[] | null,
): RunReportState {
	const { focusCaseId, shown } = useShownView(view, runId);
	const shape = runShape(shown);
	const runFinished = shown.status === "completed" || shown.status === "canceled";
	const rerun = useRerunJourney(runId);
	const rerunSuite = useRerunSuite(runId);
	const [picked, setPicked] = useState<string | null>(null);
	const [sidePane, setSidePane] = useState<SideSectionName>("artifacts");
	// The report opens on what broke: a reader landing on a failed run should
	// never have to go looking for the failure. A deep link outranks that.
	const selected =
		shown.cases.find((entry) => entry.id === (picked ?? focusCaseId))?.id ??
		reportOpeningCase(shape, shown);
	const selectedCase =
		shown.cases.find((entry) => entry.id === selected) ?? null;
	const model = runReportModel(shown, shape, runFinished, log);
	return {
		artifactPreview: useArtifactPreview(model.log ?? []),
		handOff: (suiteCase, verdict) =>
			reproCopied(
				navigator.clipboard.writeText(
					buildReproPrompt({
						caseRunId: suiteCase.id,
						journeyTitle: suiteCase.title,
						verdict,
					}),
				),
			),
		model,
		rerun: (caseRunId: string) => rerun.mutate(caseRunId),
		rerunAll: () => rerunSuite.mutate(),
		rerunning: rerun.isPending || rerunSuite.isPending,
		retryable:
			Boolean(selected) &&
			shown.actionable &&
			(selectedCase?.retryable ?? false),
		runFinished,
		selected,
		selectedCase,
		setSelected: setPicked,
		shape,
		side: { pane: sidePane, toggle: setSidePane },
		view: shown,
	};
}

/** "Broke at step 4 of 6 · <goal>" — only the repro prompt spells this out. */
