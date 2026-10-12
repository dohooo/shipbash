"use client";

/**
 * A finished walk, replayed as one thing — the one player every page that
 * shows a recording mounts: the run report, the shared run and a journey's
 * history. Pages mount this, not the pieces it is
 * built from (`RecordingCinema`, `RecordingTimeline`, `RecordingControls`,
 * `useBrowserRecordingPlayer`), so every page shows the same whole player.
 *
 * The video is the clock. The Browser/Terminal tabs, the follow switch and the
 * terminal panel all read the same playhead, so a reader watching the recording
 * sees the shell fill in at the moment the agent was typing in it, and the
 * three can never tell three different stories about one moment. The tabs and
 * the switch appear once the walk kept a shell to show.
 *
 * The player is split across the tabs: its video frame is the Browser pane,
 * and its control strip sits under both panes. A reader watching the terminal
 * still has the scrubber, the play button and the terminal marks under their
 * hand; the frame goes behind the shell by visibility, so the `<video>` keeps
 * its box and keeps driving the clock everything else reads.
 */
import type { ReactNode } from "react";
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { attentionShellAt, attentionSurfaceAt } from "@shipbash/contracts/runtime/attention-track.mjs";
import { recordingClock } from "@shipbash/contracts/runtime/recording-clock.mjs";
import type { BrowserRecordingViewModel } from "@shipbash/contracts/api/view-types";
import type { RetainedTerminalLog } from "./activity-terminal";
import { BrowserMockupChrome } from "./browser-mockup-chrome";
import { browserRecordingActiveChapterTitle, safeRecordingUrl } from "./browser-recording-player-model";
import { STYLE } from "./browser-recording-player-style";
import { RecordingCinema, RecordingControls, RecordingTimeline } from "./browser-recording-player-view";
import { useLendPlayhead } from "./run-place";
import { useClockValue, useRunReplayClock } from "./run-replay-clock";
import { RunRetainedTerminal } from "./run-retained-terminal";
import { useBrowserRecordingPlayer } from "./use-browser-recording-player";
import {
	useSurfaceFollow,
	WorkbenchPanes,
	WorkbenchSurfaceHead,
	type WorkbenchSurface,
} from "./workbench-surface";

interface ReplayPlayerProps {
	recording: BrowserRecordingViewModel;
	/** The shell logs the walk retained, as its case detail lists them; none means a browser-only walk. */
	terminalLogs: readonly RetainedTerminalLog[];
	/** The journey this walk covered: it titles the window and names the replay and its video. */
	journeyTitle: string;
	/** The replay the run burned its overlay into (case-replay.mp4), which the download control fetches; null leaves no control. */
	replayUrl: string | null;
	/** The host's own card, when the player is one: the run page's middle column. */
	className?: string;
	/** A cover on the recording's frame until it is played — the report's verdict poster. */
	cover?: ReactNode;
}

type Player = ReturnType<typeof useBrowserRecordingPlayer>;

/**
 * A recording the page may not load — its URL is not a recording route — is
 * one plain line in the player's own box, decided here once: the host's
 * layout keeps its column, and no half of a player is left without the other.
 */
export function ReplayPlayer(props: ReplayPlayerProps) {
	const src = safeRecordingUrl(props.recording.contentUrl);
	if (!src) {
		return (
			<section className={rootClass(props.className)} aria-label={`Replay of ${props.journeyTitle}`}>
				<style>{STYLE}</style>
				<p className="replay-unavailable">Recording unavailable</p>
			</section>
		);
	}
	return <PlayableReplay {...props} src={src} />;
}

function rootClass(className: string | undefined): string {
	return className ? `replay-player ${className}` : "replay-player";
}

function PlayableReplay({
	className,
	cover,
	journeyTitle,
	recording,
	replayUrl,
	src,
	terminalLogs,
}: ReplayPlayerProps & { src: string }) {
	const [tab, setTab] = useState<WorkbenchSurface>("browser");
	const hasTerminal = terminalLogs.length > 0;
	const { activeSessionId, attachVideo, clock, follow, setFollow, pickTab, timeAt } =
		useReplayFollow({ hasTerminal, recording, setTab });
	const player = useBrowserRecordingPlayer({ onVideo: attachVideo, recording });
	return (
		// Fullscreen opens the whole replay: the tabs, the stage and the strip.
		<section className={rootClass(className)} aria-label={`Replay of ${journeyTitle}`} ref={player.attachCard}>
			<style>{STYLE}</style>
			<WorkbenchSurfaceHead
				hasTerminal={hasTerminal}
				label="Replay view"
				tab={tab}
				onPick={pickTab}
				follow={follow}
				onToggle={() => setFollow((was) => !was)}
			/>
			<WorkbenchPanes
				browser={
					<div className="replay-stage">
						<ReplayCinema cover={cover} journeyTitle={journeyTitle} player={player} recording={recording} src={src} />
					</div>
				}
				tab={tab}
				terminal={hasTerminal ? (
					// Keyed by recording: each walk's sessions are its own, and a
					// remount is what drops the last one's scrollback.
					<RunRetainedTerminal
						key={recording.id}
						activeSessionId={activeSessionId}
						timeAt={timeAt}
						clock={clock}
						logs={terminalLogs}
					/>
				) : null}
			/>
			<ReplayStrip player={player} recording={recording} replayUrl={replayUrl} />
		</section>
	);
}

/** The letterboxed browser window: the journey's window chrome over the video. */
function ReplayCinema({
	cover,
	journeyTitle,
	player,
	recording,
	src,
}: {
	cover: ReactNode;
	journeyTitle: string;
	player: Player;
	recording: BrowserRecordingViewModel;
	src: string;
}) {
	const { activeRate, baseRate, currentMs, playing } = player;
	return (
		<RecordingCinema
			activeRate={activeRate}
			aspect={{ aspectRatio: `${String(recording.width)} / ${String(recording.height)}` }}
			caption={player.caption}
			chapterTitle={browserRecordingActiveChapterTitle(currentMs, recording.chapters)}
			cinemaRef={player.cinemaRef}
			cover={player.started ? null : cover}
			fastForwarding={activeRate > baseRate && playing}
			header={<BrowserMockupChrome address="" title={journeyTitle} />}
			label={`Browser recording for ${journeyTitle}`}
			onTogglePlay={player.togglePlay}
			pointer={player.pointer}
			pointerCount={player.pointers.length}
			poster={safeRecordingUrl(recording.posterUrl)}
			recordingId={recording.id}
			src={src}
			sync={player.sync}
			videoRef={player.attachVideo}
			windowWidth={player.windowWidth}
		/>
	);
}

/** The control strip under both panes: the marked scrubber and the transport. */
function ReplayStrip({ player, recording, replayUrl }: { player: Player; recording: BrowserRecordingViewModel; replayUrl: string | null }) {
	const { baseRate, currentMs, durationMs, playing } = player;
	return (
		<div className="qrp-chrome">
			<RecordingTimeline
				attention={recording.attention}
				chapters={recording.chapters}
				currentMs={currentMs}
				durationMs={durationMs}
				onPointerDown={player.handleTimelineDown}
				onPointerMove={player.handleTimelineMove}
				onSeekToMs={player.seekToMs}
				pointers={player.pointers}
				progress={durationMs > 0 ? Math.min(1, currentMs / durationMs) : 0}
				speedSegments={player.speedSegments}
				timelineRef={player.timelineRef}
			/>
			<RecordingControls
				atStart={currentMs <= 0}
				baseRate={baseRate}
				currentMs={currentMs}
				durationMs={durationMs}
				onCycleRate={player.cycleRate}
				replayUrl={replayUrl}
				onSeekBy={player.seekBy}
				onSeekToStart={player.seekToStart}
				onToggleFullscreen={player.toggleFullscreen}
				onTogglePlay={player.togglePlay}
				playing={playing}
			/>
		</div>
	);
}

/**
 * Where the replay looks, and what moves it there. A finished walk has no
 * socket left to ask, so the recorded attention track answers at the playhead:
 * which surface the agent was on, and which of several shells was the one they
 * were typing in — not always the newest.
 */
function useReplayFollow({
	hasTerminal,
	recording,
	setTab,
}: {
	hasTerminal: boolean;
	recording: BrowserRecordingViewModel;
	setTab: Dispatch<SetStateAction<WorkbenchSurface>>;
}) {
	const replay = useRunReplayClock();
	useLendPlayhead(replay.clock);
	const { attention } = recording;
	// The recording's own clock, made once. Without one the sessions cannot be
	// placed on the video's timeline at all, and the panel falls back to taking
	// each log whole.
	const timeAt = useMemo(
		() => recordingClock(recording.anchors, recording.durationMs),
		[recording.anchors, recording.durationMs],
	);
	const replaySurface = useClockValue<WorkbenchSurface>(
		replay.clock,
		useCallback((atMs: number) => attentionSurfaceAt(attention, atMs), [attention]),
		"browser",
	);
	const activeSessionId = useClockValue<string | null>(
		replay.clock,
		useCallback(
			(atMs: number) => attentionShellAt(attention, timeAt ? atMs : Number.POSITIVE_INFINITY),
			[timeAt, attention],
		),
		null,
	);
	const follow = useSurfaceFollow<WorkbenchSurface>({
		setTab,
		browserTab: "browser",
		terminalTab: "terminal",
		live: replay.running,
		hasTerminal,
		agentSurface: replaySurface,
	});
	return { ...follow, activeSessionId, attachVideo: replay.attach, clock: replay.clock, timeAt };
}
