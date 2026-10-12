"use client";

import { useState, type ReactNode } from "react";

import {
	ActivityTerminal,
	type RetainedTerminalLog,
	type TermSession,
} from "./activity-terminal";
import type { TerminalFeed } from "./terminal-feed";
import { RunRetainedTerminal } from "./run-retained-terminal";
import {
	type LiveRunBrowserProps,
	RunBrowserPane,
	runSelectedCase,
} from "./live-run-browser";
import { caseReplayUrl } from "../_lib/evidence";
import { ReplayPlayer } from "./replay-player";
import {
	useSurfaceFollow,
	WorkbenchPanes,
	WorkbenchSurfaceHead,
	type WorkbenchSurface,
} from "./workbench-surface";


const NO_RETAINED_LOGS: readonly RetainedTerminalLog[] = [];

/** The run's terminal lane, fed by the same socket as the browser stream. */
export interface RunTerminalState {
	sessions: readonly TermSession[];
	feed: TerminalFeed;
}

interface RunWorkbenchProps extends LiveRunBrowserProps {
	/** Where the agent is working right now; the followed tab tracks THIS. */
	agentSurface: WorkbenchSurface;
	terminal: RunTerminalState;
	/** A cover the host draws on a replayed walk's frame; the report's poster. */
	replayCover?: (caseRunId: string) => ReactNode;
}

/**
 * The run page's middle column: the same workbench the Discovery page wears,
 * over the run's own two surfaces. Browser and Terminal tabs with a follow
 * switch; the journey rail, the case detail and the execution log sit around
 * it.
 *
 * A journey that finished with a recording is no longer watched here but
 * replayed, and the replay is the one the report wears too. Everything else —
 * the live stream, and a finished journey whose recording never landed — stays
 * on the stream's own surfaces.
 */
export function RunWorkbench(props: RunWorkbenchProps) {
	const { completed } = props;
	const selectedCase = runSelectedCase(props);
	const recording = completed ? selectedCase?.detail.recording ?? null : null;
	// A finished journey has no socket left to watch, so its panel replays the
	// logs the run retained instead. The tab exists as soon as we know a log is
	// there, before the fetch that fills it lands.
	const retained = completed ? selectedCase?.detail.terminalLogs ?? NO_RETAINED_LOGS : NO_RETAINED_LOGS;
	if (selectedCase && recording) {
		return (
			<ReplayPlayer
				className="browser-column"
				cover={props.replayCover?.(selectedCase.id)}
				journeyTitle={selectedCase.title}
				recording={recording}
				replayUrl={caseReplayUrl(selectedCase.detail.artifacts)}
				terminalLogs={retained}
			/>
		);
	}
	return <RunStreamWorkbench {...props} retained={retained} />;
}

/**
 * The run's two live surfaces: the browser stream and the sandbox shell riding
 * the same socket, plus the frozen pair a finished journey with no recording is
 * left with.
 */
function RunStreamWorkbench(props: RunWorkbenchProps & { retained: readonly RetainedTerminalLog[] }) {
	const { agentSurface, completed, retained, selectedCaseRunId, terminal } = props;
	const [tab, setTab] = useState<WorkbenchSurface>("browser");
	const hasTerminal = completed ? retained.length > 0 : terminal.sessions.length > 0;
	// Following needs a clock, and a finished journey with no recording has
	// none: the reader drives the tabs themselves.
	const { follow, setFollow, pickTab } = useSurfaceFollow<WorkbenchSurface>({
		setTab,
		browserTab: "browser",
		terminalTab: "terminal",
		live: !completed,
		hasTerminal,
		agentSurface,
	});
	return (
		<section
			className="browser-column"
			aria-label="Live browser, sandbox terminal and journey evidence"
		>
			<WorkbenchSurfaceHead
				hasTerminal={hasTerminal}
				label="Run view"
				tab={tab}
				onPick={pickTab}
				follow={follow}
				onToggle={() => setFollow((was) => !was)}
			/>
			<WorkbenchPanes
				browser={<RunBrowserPane {...props} />}
				tab={tab}
				terminal={hasTerminal ? (
					completed
						// Keyed by journey: each case run's sessions are its own, and a
						// remount is what drops the last one's scrollback.
						? <RunRetainedTerminal key={selectedCaseRunId ?? ""} logs={retained} />
						: <ActivityTerminal sessions={terminal.sessions} feed={terminal.feed} live input={null} />
				) : null}
			/>
		</section>
	);
}
