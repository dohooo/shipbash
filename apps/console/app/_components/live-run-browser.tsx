"use client";

import type { ReactNode, Ref } from "react";

import type { RunCaseView, RunPageView } from "@shipbash/contracts/api/view-types";
import type { AgentPointerSignal } from "./agent-cursor";
import { AgentCursorOverlay } from "./agent-cursor";
import { BrowserIdlePlaceholder } from "./browser-idle-placeholder";
import { BrowserMockupChrome } from "./browser-mockup-chrome";
import { BrowserViewport } from "./browser-viewport";
import { CaseEvidence } from "./live-run-panels";

export interface BrowserLayoutState {
	address: string;
	placeholderLabel?: string;
	canvasHidden?: boolean;
	evidenceLink?: boolean;
	canvasRef: Ref<HTMLCanvasElement>;
	frameRef: Ref<HTMLDivElement>;
	frameViewport: { width: number; height: number } | null;
	handbackPicture: string | null;
	streamHealth: "connected" | "connecting" | null;
	streamViewport: { width: number; height: number } | null;
	title: string;
}

export interface LiveRunBrowserProps {
	agentPointer: AgentPointerSignal | null;
	/**
	 * A cover the host draws over the selected walk's own frame — the report's
	 * poster. A walk whose recording never landed still has a frame and still
	 * has to say what stopped it, so the cover rides this pane too, not only
	 * the replay.
	 */
	replayCover?: (caseRunId: string) => ReactNode;
	browser: BrowserLayoutState;
	completed: boolean;
	selectedCaseRunId: string | null;
	view: RunPageView;
}

/** The journey the rail has selected, whose evidence the workbench shows. */
export function runSelectedCase({
	selectedCaseRunId,
	view,
}: Pick<LiveRunBrowserProps, "selectedCaseRunId" | "view">): RunCaseView | null {
	return view.cases.find((suiteCase) => suiteCase.id === selectedCaseRunId) ?? null;
}

/**
 * The browser half of the run workbench: the live canvas while the walk runs,
 * and the selected journey's evidence once it is over. A journey that kept a
 * recording is replayed instead — see `replay-player` — so this pane never plays
 * one. The workbench around it owns the card and its tabs.
 */
export function RunBrowserPane(props: LiveRunBrowserProps) {
	const { browser, completed } = props;
	const selectedCase = runSelectedCase(props);
	return (
		<div className="run-browser-space">
			<div className={`run-browser browser-mockup${completed ? " completed" : ""}`}>
				<BrowserMockupChrome
					address={browser.address}
					title={browser.title}
				/>
				<div className="browser-stage">
					<RunBrowserViewport {...props} />
					<div
						className="case-evidence-stage"
						id="case-evidence-stage"
						hidden={!completed}
					>
						{selectedCase ? <CaseEvidence suiteCase={selectedCase} selected link={browser.evidenceLink ?? true} /> : null}
						{selectedCase && completed ? props.replayCover?.(selectedCase.id) : null}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * The noVNC sign-in iframe lives on the dedicated takeover session page, not
 * in this column; while waiting_for_auth the paused stream canvas (or its
 * placeholder) is all the run page shows.
 */
function RunBrowserViewport({
	agentPointer,
	browser,
	completed,
	view,
}: LiveRunBrowserProps) {
	const viewport = browser.streamViewport ?? browser.frameViewport;
	return (
		<BrowserViewport
			frameId="browser-frame"
			canvasId="browser-canvas"
			canvasHidden={browser.canvasHidden ?? false}
			takeoverActive={false}
			canvasAriaLabel="Read-only ShipBash browser stream"
			frameHidden={completed}
			canvasTabIndex={-1}
			canvasRef={browser.canvasRef}
			frameRef={browser.frameRef}
		>
			<AgentCursorOverlay
				pointer={agentPointer}
				viewport={viewport}
				turnKey={view.currentCaseRunId ?? view.id}
				visible={!completed && browser.frameViewport !== null}
			/>
			{!completed && browser.handbackPicture ? (
				// biome-ignore lint/performance/noImgElement: in-memory picture lasts only until a fresh run frame.
				<img className="stage-picture takeover-snapshot" src={browser.handbackPicture} alt="Browser at handback while the run reconnects" />
			) : null}
			{!completed && !browser.frameViewport && !browser.handbackPicture ? (
				<BrowserIdlePlaceholder working title={browser.placeholderLabel ?? "Connecting browser…"}
					copy="The picture arrives as soon as the browser is up." />
			) : null}
			{!completed &&
			(browser.frameViewport || browser.handbackPicture) &&
			browser.streamHealth === "connecting" ? (
				<div className="browser-stream-health" role="status">
					<span>Reconnecting the live view — the agent is still running.</span>
				</div>
			) : null}
		</BrowserViewport>
	);
}
