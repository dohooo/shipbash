"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode, Ref } from "react";

import type { RunEventView, RunPageView } from "@shipbash/contracts/api/view-types";
import { ActionButton } from "./action-button";
import type { AgentPointerSignal } from "./agent-cursor";
import type { ExecutionLogRow } from "./execution-log";
import type { BrowserLayoutState } from "./live-run-browser";
import { RunWorkbench, type RunTerminalState } from "./live-run-workbench";
import { CaseDetail, RunEvent, RunEventSkeleton } from "./live-run-panels";
import { startupStageMessage } from "./live-run-stream";
import { ArtifactViewer, type EventArtifact } from "./run-artifacts";
import { RunCaseRail } from "./run-case-rail";
import { PageColumn, Topbar } from "./shell";
import { useRunElapsed } from "./use-run-elapsed";
import type { Breadcrumb } from "./workspace-address";
import { runEvidenceWarnings } from "../_lib/run-report";
import { statusLabel, statusTone } from "../_lib/status";
import type { WorkbenchSurface } from "./workbench-surface";

interface ArtifactPreviewState {
	artifacts: EventArtifact[];
	close: () => void;
	index: number | null;
	open: (artifact: EventArtifact) => void;
	setIndex: (index: number | null) => void;
}

/**
 * "waiting" = amber sign-in recall, "handback" = green post-takeover state
 * while the auto-resume spins up, null = no banner.
 */
export type RunAuthBannerState = "waiting" | "handback" | null;

export interface LiveRunLayoutProps {
	trail: readonly Breadcrumb[];
	shareControl?: ReactNode;
	attentionBanner?: ReactNode;
	agentPointer: AgentPointerSignal | null;
	/** Where the agent is working right now; the followed workbench tab tracks it. */
	agentSurface: WorkbenchSurface;
	artifactPreview: ArtifactPreviewState;
	authBanner: RunAuthBannerState;
	browser: BrowserLayoutState;
	/** The log's rows the page draws; null while the log is read. */
	displayedRows: ExecutionLogRow[] | null;
	eventOrigin: string;
	onSelectCase: (caseRunId: string) => void;
	onTimelineScroll: () => void;
	cancelPending: boolean;
	onCancel: () => void;
	selectedCaseRunId: string | null;
	terminal: RunTerminalState;
	timelineRef: Ref<HTMLDivElement>;
	view: RunPageView;
	/**
	 * The run's log as the page holds it, with what the stream brought since: a
	 * Journey still waiting says from it where the run has got to. Null while
	 * the log is read, and a waiting Journey says nothing of it.
	 */
	log: readonly RunEventView[] | null;
}

export function LiveRunLayout(props: LiveRunLayoutProps) {
	return (
		<PageColumn topbar={<RunTopbar {...props} />}>
			<div className="run-page">
				{props.attentionBanner}
				<RunAuthBanner {...props} />
				<RunGrid {...props} completed={false} timeline={<RunTimeline {...props} />} />
				<ArtifactViewer
					artifacts={props.artifactPreview.artifacts}
					index={props.artifactPreview.index}
					onChange={props.artifactPreview.setIndex}
					onClose={props.artifactPreview.close}
				/>
			</div>
		</PageColumn>
	);
}

/** The walk's bar: the run named in the trail, and beside it its status, its clock and Cancel. */
function RunTopbar({
	trail,
	shareControl,
	cancelPending,
	onCancel,
	view,
}: LiveRunLayoutProps) {
	const canCancel =
		view.status === "running" || view.status === "waiting_for_auth";
	const tone = statusTone(view.status);
	const elapsed = useRunElapsed(view.startedAt, view.completedAt);
	return (
		<Topbar trail={trail} actions={
			<div className="run-meta">
				<span
					className={`status-pill ${tone}`}
					id="run-status-pill"
				>
					<span
						className={`dot ${tone}`}
						id="run-status-dot"
						aria-hidden="true"
					/>
					<span id="run-status-text">{statusLabel(view.status)}</span>
				</span>
				{runEvidenceWarnings(view).map((warning) => {
					const level = warning.failure ? "negative" : "warning";
					return (
						<span className={`status-pill ${level} ${warning.id}`} id={warning.id} key={warning.id}>
							<span className={`dot ${level}`} aria-hidden="true" />
							{warning.label}
						</span>
					);
				})}
				{/* The server's clock and the browser's are a trip apart; the next
				    tick says the browser's. */}
				<span className="elapsed" id="run-elapsed" suppressHydrationWarning>
					{`Elapsed ${elapsed}`}
				</span>
				{view.actionable || shareControl ? (
					<div className="run-controls">
						{shareControl}
						{!view.actionable ? null : canCancel ? (
							<ActionButton
								className="button danger"
								id="cancel-run"
								disabled={cancelPending}
								action={onCancel}
							>
								{cancelPending ? "…" : "Cancel"}
							</ActionButton>
						) : view.status === "canceling" ? (
							<button className="button danger" type="button" disabled>
								Canceling…
							</button>
						) : null}
					</div>
				) : null}
			</div>
		} />
	);
}

/**
 * The sign-in wall recalls the reader to a dedicated takeover session page
 * instead of hosting the private browser inline; the handback state carries
 * no actions because auth/complete already auto-resumes the run. Cancel
 * takeover and I'm done live on the session page.
 */
function RunAuthBanner({ authBanner, view }: LiveRunLayoutProps) {
	const pathname = usePathname();
	return (
		<section
			className="auth-banner"
			id="auth-banner"
			hidden={authBanner === null}
			aria-live="polite"
		>
			{authBanner === "handback" ? (
				<div className="auth-copy">
					<span className="dot positive" aria-hidden="true" />
					<div>
						<strong>Control handed back · signed in</strong>
						<span>
							The session recorded the sign-in. The walk resumes from the
							paused journey.
						</span>
					</div>
				</div>
			) : (
				<>
					<div className="auth-copy">
						<span className="dot warning" aria-hidden="true" />
						<div>
							<strong>Sign-in needed</strong>
							<span>
								{view.authPrompt ??
									"The walk is paused at the sign-in wall. Take control in a session, then come back and retry."}
							</span>
						</div>
					</div>
					{view.actionable ? (
						<div className="auth-actions">
							<Link
								className="button primary"
								id="run-take-control"
								href={{ pathname: `${pathname}/takeover` }}
							>
								Take control
							</Link>
						</div>
					) : null}
				</>
			)}
		</section>
	);
}

export type RunGridProps = Pick<LiveRunLayoutProps, "agentPointer" | "agentSurface" | "browser" | "log" | "onSelectCase" | "selectedCaseRunId" | "terminal" | "view"> & {
	/** A settled run: the report's, or the share page's once the run has ended. */
	completed: boolean;
	timeline?: ReactNode;
	caseSupplement?: (caseId: string) => ReactNode;
	/** A cover the report draws on a replayed walk's own frame. */
	replayCover?: (caseRunId: string) => ReactNode;
	/**
	 * The report's pinned panel toolbar. A zero-height sticky row at the top of
	 * the detail column: the expand while the panel is closed, the close while
	 * it is open. The live run has nothing to put there.
	 */
	panelTools?: ReactNode;
	/**
	 * The settled run's four marks, beside the journeys they count. A running
	 * walk passes nothing — there is no conclusion to tally yet — and keeps the
	 * plain total instead.
	 */
	railTally?: ReactNode;
	/**
	 * Rows to draw in the rail instead of the ones the model walked, and the
	 * bottom pane to draw instead of the per-journey details. The skeleton is
	 * the only caller: it has this grid's frame but none of its content yet,
	 * and the alternative — a second copy of the rail and the pane somewhere
	 * else — is what lets a skeleton drift away from the page it stands for.
	 */
	railRows?: ReactNode;
	caseDetail?: ReactNode;
};

export function RunGrid(props: RunGridProps) {
	return (
		<div className="run-grid">
			<RunCaseRail {...props} />
			<RunWorkbench {...props} />
			<RunCaseDetails {...props} />
			{props.timeline}
		</div>
	);
}

function RunCaseDetails({
	caseDetail,
	caseSupplement,
	completed,
	log,
	panelTools,
	selectedCaseRunId,
	view,
}: RunGridProps) {
	return (
		<section className="case-detail-row" aria-label="Selected journey result">
			{panelTools}
			{caseDetail ?? view.cases.map((suiteCase) => (
				<CaseDetail
					suiteCase={suiteCase}
					selected={suiteCase.id === selectedCaseRunId}
					pendingMessage={completed || log === null ? null : startupStageMessage(log)}
					supplement={caseSupplement?.(suiteCase.id)}
					key={suiteCase.id}
				/>
			))}
		</section>
	);
}

export function RunTimeline({
	children,
	neutralSystemEvents = false,
	artifactPreview,
	displayedRows,
	eventOrigin,
	onTimelineScroll,
	timelineRef,
}: Pick<LiveRunLayoutProps, "artifactPreview" | "displayedRows" | "eventOrigin" | "onTimelineScroll" | "timelineRef"> & { children?: ReactNode; neutralSystemEvents?: boolean }) {
	return (
		<aside
			className="timeline"
			aria-label="Sanitized action and event timeline"
		>
			<header className="column-head">
				<span className="column-head-label">
					Execution logs
					<span
						className="column-head-info"
						role="img"
						aria-label="Sanitized: tool actions and browser events only. Model reasoning is never shown."
						title="Sanitized: tool actions and browser events only. Model reasoning is never shown."
					>
						ⓘ
					</span>
				</span>
			</header>
			<div
				className="event-list"
				id="event-list"
				aria-live="polite"
				ref={timelineRef}
				onScroll={onTimelineScroll}
			>
				{displayedRows === null ? <RunLogPending /> : displayedRows.map((row) => (
					<RunEvent
						row={row}
						neutralSystem={neutralSystemEvents}
						origin={eventOrigin}
						onPreviewArtifact={artifactPreview.open}
						key={
							row.event.id ||
							`${row.event.timestamp}:${row.event.eventType}:${row.event.summary}`
						}
					/>
				))}
				{children}
			</div>
		</aside>
	);
}

const SKELETON_LOG_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;

/** The log while it is read: a column of event rows with no words yet. */
export function RunEventSkeletonRows() {
	return SKELETON_LOG_ROWS.map((key) => <RunEventSkeleton key={key} />);
}

/** A log still being read: its skeleton rows, and a status that says so. */
export function RunLogPending() {
	return (
		<>
			<p className="sr-only" role="status">Loading the log…</p>
			<RunEventSkeletonRows />
		</>
	);
}

/** RunTimeline, drawn: its head and its log's skeleton rows. */
export function RunTimelineSkeleton() {
	return (
		<aside className="timeline" aria-label="Sanitized action and event timeline">
			<header className="column-head">
				<span className="column-head-label">Execution logs</span>
			</header>
			<div className="event-list">
				<RunEventSkeletonRows />
			</div>
		</aside>
	);
}
