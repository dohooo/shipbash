"use client";

import type { RunCaseView } from "@shipbash/contracts/api/view-types";
import { ChevronRight, Eye, Images } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { CaseResult } from "../../lib/web-client";
import { caseReplayUrl, type EvidenceStep } from "../_lib/evidence";
import { formatDuration } from "../_lib/journeys";
import { buildReproPrompt, type HandoffVerdict } from "../_lib/repro-prompt";
import { route } from "../_lib/route";
import { RelativeTime } from "./relative-time";
import { ReplayPlayer } from "./replay-player";
import { HandoffButton, reproCopied } from "./handoff-button";
import { consoleFoldText, useEvidenceConsole } from "./use-evidence-console";

/** The checkpoint a walk died on, once the run's detail has arrived. */
export interface BrokenCheckpoint {
	position: string;
	goal: string;
	reason: string | null;
}

export type CaseDetail = RunCaseView["detail"];

export function ConsoleFold({ url }: { url: string }) {
	const [open, setOpen] = useState(false);
	const query = useEvidenceConsole(url, open);
	return (
		<div className="history-console">
			<button
				aria-expanded={open}
				className="history-console-toggle"
				type="button"
				onClick={() => setOpen((current) => !current)}
			>
				<ChevronRight aria-hidden="true" />
				Advanced · page console output
			</button>
			{open ? <pre>{consoleFoldText(query)}</pre> : null}
		</div>
	);
}

/** The verdict line: the whole row is the fold's toggle. */
export function HistoryRow({
	result,
	mark,
	note,
	trigger,
	open,
	onToggle,
}: {
	result: CaseResult;
	mark: string;
	note: string;
	trigger: string;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			aria-expanded={open}
			className="history-row"
			type="button"
			onClick={onToggle}
		>
			<span className="history-row-copy">
				<span className="last-run-dot" data-mark={mark} aria-hidden="true" />
				<span>
					<strong>
						<RelativeTime value={result.runAt} />
					</strong>{" "}
					— {note}
				</span>
			</span>
			<span className="history-row-meta">
				{result.isPublic ? (
					<span className="history-public-status">
						<Eye aria-hidden="true" />
						<span className="sr-only">Public run</span>
					</span>
				) : null}
				<span>{formatDuration(result.durationMs)}</span>
				<span>{trigger}</span>
				<ChevronRight aria-hidden="true" />
			</span>
		</button>
	);
}

/** Hands the whole walk to a local coding agent: its evidence, and the prompt its verdict asks for. */
export function WalkHandoff({
	journeyTitle,
	caseRunId,
	verdict,
}: {
	journeyTitle: string;
	caseRunId: string;
	verdict: HandoffVerdict;
}) {
	return (
		<HandoffButton
			onCopy={() =>
				reproCopied(
					navigator.clipboard.writeText(
						buildReproPrompt({ caseRunId, journeyTitle, verdict }),
					),
				)
			}
		/>
	);
}

/** Where it broke, and the frame captured at that moment. */
export function HistoryBreak({
	broken,
	detail,
	screenshotUrl,
}: {
	broken: BrokenCheckpoint | null;
	detail: CaseDetail | null;
	screenshotUrl: string | null;
}) {
	return (
		<div className="history-break">
			<div className="history-break-shot">
				{screenshotUrl ? (
					// The runner owns this URL: the frame captured as the walk stopped.
					// The runner owns this URL: the frame captured as the walk stopped.
					// biome-ignore lint/performance/noImgElement: a session-authorized artifact URL next/image would fetch server-side without the browser cookie.
					<img
						alt={detail?.screenshotAlt ?? "The moment it broke"}
						src={screenshotUrl}
					/>
				) : (
					<span>No frame was captured at the moment it broke</span>
				)}
			</div>
			<div className="history-break-copy">
				<span className="kicker" data-tone="negative">
					{broken ? broken.position : "Broke during the walk"}
				</span>
				{broken ? <strong>{broken.goal}</strong> : null}
				<span>
					{broken?.reason ??
						detail?.failureReason ??
						"The agent reported a failure without a reason."}
				</span>
			</div>
		</div>
	);
}

/** The walk as it can be watched: recording, single frame, or an admission. */
export function HistoryMedia({
	detail,
	failed,
	screenshotUrl,
	journeyTitle,
}: {
	detail: CaseDetail | null;
	failed: boolean;
	screenshotUrl: string | null;
	journeyTitle: string;
}) {
	if (detail?.recording) {
		return (
			<ReplayPlayer
				journeyTitle={journeyTitle}
				recording={detail.recording}
				replayUrl={caseReplayUrl(detail.artifacts)}
				terminalLogs={detail.terminalLogs}
			/>
		);
	}
	if (!failed && screenshotUrl) {
		// .history-shot sizes this to the card width; there are no fixed dimensions to declare.
		return (
			// biome-ignore lint/performance/noImgElement: a session-authorized artifact URL next/image's optimizer could not fetch.
			<img
				className="history-shot"
				alt={detail?.screenshotAlt ?? journeyTitle}
				src={screenshotUrl}
			/>
		);
	}
	if (detail?.recordingState === "preparing")
		return <p className="history-empty">Preparing recording…</p>;
	if (detail?.recordingState === "uploading")
		return <p className="history-empty">Uploading recording…</p>;
	if (detail?.recordingState === "failed")
		return <p className="history-empty">Recording unavailable</p>;
	if (detail)
		return (
			<p className="history-empty">No recording was retained for this walk.</p>
		);
	return null;
}

/** The step-strip toggle, and the way out to the whole run. */
export function HistoryControls({
	steps,
	shotsOpen,
	onToggleShots,
	runHref,
}: {
	steps: readonly EvidenceStep[];
	shotsOpen: boolean;
	onToggleShots: () => void;
	runHref: string;
}) {
	return (
		<div className="history-controls">
			{steps.length ? (
				<button
					aria-expanded={shotsOpen}
					className="history-shots-toggle"
					data-open={shotsOpen ? "true" : undefined}
					type="button"
					onClick={onToggleShots}
				>
					<Images aria-hidden="true" />
					Step screenshots ({steps.length})
				</button>
			) : (
				<span />
			)}
			<Link className="history-run-link" href={route(runHref)}>
				View the whole run →
			</Link>
		</div>
	);
}

export function HistoryShots({ steps }: { steps: readonly EvidenceStep[] }) {
	return (
		<div className="history-shots">
			{steps.map((step) => (
				<figure key={step.id}>
					{/* biome-ignore lint/performance/noImgElement: session-authorized step captures; next/image would fetch them
              server-side without the browser cookie, and the grid sizes them by CSS. */}
					<img
						alt={`Step ${String(step.sequence)}: ${step.action}`}
						src={step.url}
					/>
					<figcaption>
						Step {step.sequence} · {step.action}
					</figcaption>
				</figure>
			))}
		</div>
	);
}
