"use client";

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { safeBrowserStreamUrl } from "../../lib/client-contracts";
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import type { LiveRunViewModel as RunView, RunEventView, RunPageView } from "@shipbash/contracts/api/view-types";
import type { LogRead } from "../../lib/queries";
import { latestRunAgentSurface } from "../_lib/run-agent-surface";
import { useTerminalLane } from "./activity-terminal";
import { useAgentPointerFeed } from "./agent-cursor";
import { buildExecutionLog, shouldStickToBottom } from "./execution-log";
import { clearHandback, clearHandbackPicture, readHandback, readHandbackPicture } from "./handback-intent";
import { LiveRunLayout, type RunAuthBannerState } from "./live-run-layout";
import { latestPointerSignal, mergeEventTimelines } from "./live-run-stream";
import { useArtifactPreview } from "./run-artifacts";
import { useRunEventStream } from "./use-live-run-sync";
import { useRunBrowserStream } from "./use-run-browser-stream";
import { useRunCancel } from "./use-run-cancel";
import type { Breadcrumb } from "./workspace-address";

/**
 * The live verification page's state coordinator. Stream plumbing lives in
 * the use-run-* hooks and the DOM contract lives in
 * live-run-layout.tsx. It draws a run that has not ended: the page hands a
 * settled run to its report (run-detail.tsx).
 */
interface LiveRunProps {
	/** The trail the page names the run with, in the bar over the live view. */
	trail: readonly Breadcrumb[];
	shareControl?: ReactNode;
	attentionBanner?: ReactNode;
	projectId: string;
	runId: string;
	/** The run as the page reads it; the event stream writes into that same read. */
	view: RunView;
	/**
	 * The log of `view.eventsRunId` as the page holds it (`verificationLog`),
	 * null until it is read. The page is keyed by that run, so another run's
	 * log is another page.
	 */
	log: LogRead<RunEventView> | null;
	controlEndpoint?: string;
	/** Whether the event stream is carrying the run, so the page can slow its own reads. */
	onLiveChange: (live: boolean) => void;
}

export function LiveRun({
	trail,
	shareControl,
	attentionBanner,
	projectId,
	runId,
	view,
	log,
	controlEndpoint = `/api/runs/${encodeURIComponent(runId)}`,
	onLiveChange,
}: LiveRunProps) {
	const [selectedCaseRunId, setSelectedCaseRunId] = useSelectedCase(view);
	const [streamRevision, setStreamRevision] = useState(0);
	const handbackPicture = useRunHandbackPicture(runId);
	const {
		pointer: agentPointer,
		applyStreamMessage: applyPointerStreamMessage,
		applyFallback: applyPointerFallback,
	} = useRunPointerFeed(log?.events ?? NO_EVENTS);
	const { appendEvent, browserEvents, seenEventIds } = useBrowserEvents(
		log?.events ?? NO_EVENTS,
	);
	const streamAfter = useStreamCursor(log);
	const runStatusRef = useRunStatus(view.status);
	const browserStreamUrl = safeBrowserStreamUrl(view.streamUrl);
	const cancel = useRunCancel({ projectId, runId, appendEvent });
	const authBanner = useRunAuthBanner(runId, view.status);
	// The sandbox terminal rides the browser stream's socket; its state lives
	// here so the sessions and their scrollback survive tab switches.
	const terminal = useTerminalLane();

	useRunEventStream({
		controlEndpoint,
		projectId,
		runId,
		initialLastEventSequence: streamAfter,
		seenEventIds,
		runStatusRef,
		appendEvent,
		applyPointerFallback,
		onStreamReady: () => setStreamRevision((revision) => revision + 1),
		onLiveChange,
	});
	const browser = useRunBrowserStream({
		browserStreamUrl,
		streamRevision,
		runStatusRef,
		projectName: view.projectName,
		appendEvent,
		applyPointerStreamMessage,
		onTermMessage: terminal.handleTermMessage,
		onFreshFrame: handbackPicture.clear,
	});
	const timeline = useTimelineStickiness();
	const mergedEvents = liveTimeline(log?.events ?? NO_EVENTS, browserEvents);
	// The live page draws the log's last rows; the report draws all of them.
	const displayedRows = log ? buildExecutionLog(mergedEvents.slice(-LIVE_LOG_ROWS)) : null;
	const eventOrigin = mergedEvents[0]?.timestamp ?? new Date().toISOString();
	const artifactPreview = useArtifactPreview(displayedRows ?? []);
	return (
		<LiveRunLayout
			trail={trail}
			shareControl={shareControl}
			attentionBanner={attentionBanner}
			agentPointer={agentPointer}
			agentSurface={latestRunAgentSurface(mergedEvents)}
			artifactPreview={artifactPreview}
			authBanner={authBanner}
			browser={{
				address: browser.browserAddress,
				canvasRef: browser.canvasRef,
				frameRef: browser.frameRef,
				frameViewport: browser.frameViewport,
				handbackPicture: handbackPicture.value,
				streamHealth: browser.streamHealth,
				streamViewport: browser.streamViewport,
				title: browser.browserTitle,
			}}
			displayedRows={displayedRows}
			eventOrigin={eventOrigin}
			onSelectCase={setSelectedCaseRunId}
			onTimelineScroll={timeline.onScroll}
			cancelPending={cancel.isPending}
			onCancel={() => cancel.mutate()}
			selectedCaseRunId={selectedCaseRunId}
			terminal={{ sessions: terminal.sessions, feed: terminal.feed }}
			timelineRef={timeline.ref}
			view={view}
			log={log ? mergedEvents : null}
		/>
	);
}

/** The rows the live page draws, and the lines the stream and the browser brought it at most. */
const LIVE_LOG_ROWS = 300;

const NO_EVENTS: readonly RunEventView[] = [];

/**
 * Where the stream picks up: the event the page's log ends with once it is
 * read, null until then. It holds still while the run streams, so the
 * subscription is not rebuilt per read of the log.
 */
function useStreamCursor(log: LogRead<RunEventView> | null): number | null {
	const cursor = useRef<number | null>(null);
	if (cursor.current === null && log) cursor.current = log.nextAfter;
	return cursor.current;
}

/**
 * The page's log and the lines only this tab holds, in time order. A line the
 * stream brought that the log has since read too is the log's.
 */
function liveTimeline(
	log: readonly RunEventView[],
	local: readonly RunEventView[],
): RunEventView[] {
	const logged = new Set(log.map((event) => event.id));
	return mergeEventTimelines(log, local.filter((event) => !logged.has(event.id)));
}

/**
 * The picture this tab handed control back with, shown until the resumed run
 * paints a fresh frame. It is read each time the page is shown, because Next
 * keeps the run page mounted, hidden, while the reader is on its takeover
 * page. A fresh frame lets it go, and it never outlives the handback intent.
 */
function useRunHandbackPicture(runId: string) {
	const [value, setValue] = useState<string | null>(null);
	useLayoutEffect(() => {
		setValue(readHandbackPicture(runId));
	}, [runId]);
	const clear = () => { clearHandbackPicture(runId); setValue(null); };
	return { value, clear };
}

/**
 * Which recall banner the run shows. Waiting on a sign-in is amber and sends
 * the reader to the takeover session page; a fresh handback intent recolors
 * it green while the auto-resumed run spins back up (waiting_for_auth until
 * the capture lands, then queued). The run actually resuming — or ending —
 * retires the intent so the NEXT sign-in wall starts amber again.
 */
function useRunAuthBanner(
	runId: string,
	status: SuiteRunStatus,
): RunAuthBannerState {
	const [handback, setHandback] = useState(false);
	useEffect(() => {
		if (status === "waiting_for_auth" || status === "queued") {
			setHandback(readHandback(runId) !== null);
			return;
		}
		clearHandback(runId);
		setHandback(false);
	}, [runId, status]);
	if (handback && (status === "waiting_for_auth" || status === "queued"))
		return "handback";
	return status === "waiting_for_auth" ? "waiting" : null;
}

function useRunPointerFeed(
	initialEvents: readonly RunEventView[],
) {
	const feed = useAgentPointerFeed();
	useEffect(() => {
		feed.applyFallback(latestPointerSignal(initialEvents));
	}, [feed.applyFallback, initialEvents]);
	return feed;
}

function useSelectedCase(view: RunPageView) {
	const [selectedCaseRunId, setSelectedCaseRunId] = useState(
		view.cases[0]?.id ?? null,
	);
	useEffect(() => {
		if (!view.cases.some((suiteCase) => suiteCase.id === selectedCaseRunId)) {
			setSelectedCaseRunId(view.cases[0]?.id ?? null);
		}
	}, [selectedCaseRunId, view.cases]);
	useEffect(() => {
		if (view.currentCaseRunId) setSelectedCaseRunId(view.currentCaseRunId);
	}, [view.currentCaseRunId]);
	return [selectedCaseRunId, setSelectedCaseRunId] as const;
}

function useBrowserEvents(
	initialEvents: readonly RunEventView[],
) {
	const [browserEvents, setBrowserEvents] = useState<
		RunEventView[]
	>([]);
	const sequenceRef = useRef(0);
	const seenIdsRef = useRef<Set<string> | null>(null);
	if (!seenIdsRef.current) {
		seenIdsRef.current = new Set(
			initialEvents.flatMap((event) => (event.id ? [event.id] : [])),
		);
	}
	const seenEventIds = seenIdsRef.current;
	const appendEvent = useCallback(
		(event: RunEventView) => {
			if (event.id) {
				if (seenEventIds.has(event.id)) return;
				seenEventIds.add(event.id);
			}
			sequenceRef.current += 1;
			const identified = event.id
				? event
				: { ...event, id: `browser-event-${String(sequenceRef.current)}` };
			setBrowserEvents((current) => [...current, identified].slice(-LIVE_LOG_ROWS));
		},
		[seenEventIds],
	);
	return { appendEvent, browserEvents, seenEventIds };
}

function useRunStatus(status: SuiteRunStatus) {
	const statusRef = useRef(status);
	useEffect(() => {
		statusRef.current = status;
	}, [status]);
	return statusRef;
}

function useTimelineStickiness() {
	const timelineRef = useRef<HTMLDivElement>(null);
	const stickRef = useRef(true);
	useEffect(() => {
		const timeline = timelineRef.current;
		if (timeline && stickRef.current)
			timeline.scrollTop = timeline.scrollHeight;
	});
	const onScroll = useCallback(() => {
		const timeline = timelineRef.current;
		if (timeline) stickRef.current = shouldStickToBottom(timeline);
	}, []);
	return { onScroll, ref: timelineRef };
}
