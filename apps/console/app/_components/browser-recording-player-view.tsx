"use client";

import { Clock, Download, Maximize, Pause, Play, RotateCcw, RotateCw, SkipBack } from "lucide-react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, Ref, RefObject } from "react";

import { attentionSegments } from "@shipbash/contracts/runtime/attention-track.mjs";
import { artifactDownloadUrl } from "@shipbash/contracts/api/artifact-download";
import type { BrowserRecordingViewModel } from "@shipbash/contracts/api/view-types";
import { AgentCursorOverlay, type AgentPointerSignal } from "./agent-cursor";
import { ChapterMarks } from "./browser-recording-player-chapters";
import { formatTime } from "./browser-recording-player-model";

const REPLAY_POINTER_VIEWPORT = { width: 1, height: 1 };

/**
 * The letterboxed browser window: a hidden ghost reserves the largest box the
 * cinema can hold, and the real window sits on top of it at that width.
 */
export function RecordingCinema({
  activeRate,
  aspect,
  caption,
  chapterTitle,
  cinemaRef,
  cover,
  fastForwarding,
  header,
  label,
  onTogglePlay,
  pointer,
  pointerCount,
  poster,
  recordingId,
  src,
  sync,
  videoRef,
  windowWidth,
}: {
  activeRate: number;
  aspect: CSSProperties;
  caption: string | null;
  /** The chapter the caption belongs to, named beside it. */
  chapterTitle: string | null;
  cinemaRef: RefObject<HTMLDivElement | null>;
  /** What the walk's cover says, drawn on the frame until playback starts. */
  cover?: ReactNode;
  fastForwarding: boolean;
  /** The window chrome drawn over the video. */
  header: ReactNode;
  label: string;
  onTogglePlay: () => void;
  pointer: AgentPointerSignal | null;
  pointerCount: number;
  poster: string | undefined;
  recordingId: string;
  src: string;
  sync: () => void;
  videoRef: Ref<HTMLVideoElement>;
  windowWidth: number | null;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-pause on the letterbox backdrop, the way every video player behaves.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the labelled play button below already carries the keyboard path.
    <div className="qrp-cinema" ref={cinemaRef} onClick={onTogglePlay}>
      <div className="qrp-ghost" aria-hidden="true">
        <div className="qrp-ghost-header" />
        <div style={aspect} />
      </div>
      <div className="qrp-window browser-mockup" style={windowWidth ? { width: windowWidth } : undefined}>
        {header}
        <div className="qrp-frame" style={aspect}>
          <video
            ref={videoRef}
            src={src}
            poster={poster}
            preload="metadata"
            playsInline
            muted
            aria-label={label}
            onTimeUpdate={sync}
            onPlay={sync}
            onPause={sync}
            onSeeking={sync}
            onLoadedMetadata={sync}
            onEnded={sync}
          />
          <AgentCursorOverlay
            pointer={pointer}
            viewport={REPLAY_POINTER_VIEWPORT}
            turnKey={recordingId}
            visible={pointerCount > 0}
          />
          {fastForwarding ? <div className="qrp-ff">⏩ {activeRate}×</div> : null}
          {caption ? (
            <div className="qrp-caption" data-testid="recording-caption">
              {chapterTitle
                ? <span className="qrp-caption-chapter" data-testid="recording-chapter">{chapterTitle}</span>
                : null}
              {caption}
            </div>
          ) : null}
          {cover}
        </div>
      </div>
    </div>
  );
}

/**
 * The scrubber: chapter dividers, Agent action marks, the grayed static
 * stretches, and the fill. A case run walked twice chapters each walk, so the
 * dividers are also where the reader jumps from the failure to the re-run.
 */
export function RecordingTimeline({
  attention,
  chapters,
  currentMs,
  durationMs,
  onPointerDown,
  onPointerMove,
  onSeekToMs,
  pointers,
  progress,
  speedSegments,
  timelineRef,
}: {
  attention: BrowserRecordingViewModel["attention"];
  chapters: BrowserRecordingViewModel["chapters"];
  currentMs: number;
  durationMs: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSeekToMs: (milliseconds: number) => void;
  pointers: BrowserRecordingViewModel["pointers"];
  progress: number;
  speedSegments: BrowserRecordingViewModel["speedSegments"];
  timelineRef: RefObject<HTMLDivElement | null>;
}) {
  // Where the walk left the browser for a shell. Read off the same track the
  // followed tab uses, so the scrubber and the panel agree on when it moved.
  const terminalSwitches = attentionSegments(attention, durationMs)
    .filter((segment) => segment.surface === "terminal");
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the scrubber is pointer-only.
    <div
      className="qrp-timeline"
      ref={timelineRef}
      role="slider"
      aria-label="Recording timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationMs / 1_000)}
      aria-valuenow={Math.round(currentMs / 1_000)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      <div className="qrp-events">
        <ChapterMarks chapters={chapters} durationMs={durationMs} onSeekToMs={onSeekToMs} />
        {terminalSwitches.map((segment) => (
          <button
            className="qrp-mark qrp-terminal-mark qrp-tip"
            key={`terminal-${String(segment.startMs)}`}
            type="button"
            data-tip={`Switched to terminal: ${segment.label ?? segment.sessionId ?? "sandbox"}`}
            aria-label={`Jump to the terminal at ${formatTime(segment.startMs)}`}
            style={{ left: `${String((segment.startMs / durationMs) * 100)}%` }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSeekToMs(segment.startMs);
            }}
          />
        ))}
        {pointers.map((entry, index) => (
          <button
            className="qrp-mark qrp-tip"
            key={`${String(entry.atMs)}-${String(index)}`}
            type="button"
            data-tip={`${entry.action} · ${formatTime(entry.atMs)}`}
            aria-label={`Jump to ${entry.action} at ${formatTime(entry.atMs)}`}
            style={{ left: `${String((entry.atMs / durationMs) * 100)}%` }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSeekToMs(entry.atMs);
            }}
          />
        ))}
      </div>
      <div className="qrp-track">
        {speedSegments.map((segment) => (
          <div
            className="qrp-static"
            key={`${String(segment.startMs)}-${String(segment.endMs)}`}
            style={{
              left: `${String((segment.startMs / durationMs) * 100)}%`,
              width: `${String(((segment.endMs - segment.startMs) / durationMs) * 100)}%`,
            }}
          />
        ))}
        <div className="qrp-fill" style={{ width: `${String(progress * 100)}%` }} />
      </div>
      <div className="qrp-thumb" style={{ left: `${String(progress * 100)}%` }} />
    </div>
  );
}

/** The transport row under the scrubber. */
export function RecordingControls({
  atStart,
  baseRate,
  currentMs,
  durationMs,
  onCycleRate,
  onSeekBy,
  onSeekToStart,
  onToggleFullscreen,
  onTogglePlay,
  playing,
  replayUrl,
}: {
  atStart: boolean;
  baseRate: number;
  currentMs: number;
  durationMs: number;
  onCycleRate: () => void;
  onSeekBy: (deltaSeconds: number) => void;
  onSeekToStart: () => void;
  onToggleFullscreen: () => void;
  onTogglePlay: () => void;
  playing: boolean;
  replayUrl: string | null;
}) {
  return (
    <div className="qrp-controls">
      <PlaybackButtons
        atStart={atStart}
        currentMs={currentMs}
        durationMs={durationMs}
        onSeekBy={onSeekBy}
        onSeekToStart={onSeekToStart}
        onTogglePlay={onTogglePlay}
        playing={playing}
      />
      <ViewingButtons
        baseRate={baseRate}
        onCycleRate={onCycleRate}
        onToggleFullscreen={onToggleFullscreen}
        replayUrl={replayUrl}
      />
    </div>
  );
}

/** Start, skip, play/pause and the clock: the left half of the control row. */
function PlaybackButtons({
  atStart,
  currentMs,
  durationMs,
  onSeekBy,
  onSeekToStart,
  onTogglePlay,
  playing,
}: {
  atStart: boolean;
  currentMs: number;
  durationMs: number;
  onSeekBy: (deltaSeconds: number) => void;
  onSeekToStart: () => void;
  onTogglePlay: () => void;
  playing: boolean;
}) {
  return (
    <>
      <button
        className="qrp-button qrp-tip"
        type="button"
        data-tip="Go to start"
        aria-label="Go to start"
        disabled={atStart}
        onClick={onSeekToStart}
      >
        <SkipBack aria-hidden="true" />
      </button>
      <button
        className="qrp-button qrp-tip"
        type="button"
        data-tip="Back 10 seconds"
        aria-label="Back 10 seconds"
        onClick={() => onSeekBy(-10)}
      >
        <RotateCcw aria-hidden="true" />
        <span className="qrp-badge">10</span>
      </button>
      <button
        className="qrp-button qrp-tip"
        type="button"
        data-tip={playing ? "Pause" : "Play"}
        aria-label={playing ? "Pause recording" : "Play recording"}
        onClick={onTogglePlay}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <button
        className="qrp-button qrp-tip"
        type="button"
        data-tip="Forward 10 seconds"
        aria-label="Forward 10 seconds"
        onClick={() => onSeekBy(10)}
      >
        <RotateCw aria-hidden="true" />
        <span className="qrp-badge">10</span>
      </button>
      <span className="qrp-time">
        <Clock aria-hidden="true" />
        {formatTime(currentMs)} / {formatTime(durationMs)}
      </span>
    </>
  );
}

/**
 * Speed, download and fullscreen: the right half, pushed over by the spacer.
 * The spacer stays a sibling of both halves so the row's first-child and
 * last-child tooltip rules still find the buttons at each end. The download
 * is the replay the run itself burned its captions, cursor and chapters into,
 * the file a Slack thread is sent, fetched as the Artifacts column fetches it.
 */
function ViewingButtons({
  baseRate,
  onCycleRate,
  onToggleFullscreen,
  replayUrl,
}: {
  baseRate: number;
  onCycleRate: () => void;
  onToggleFullscreen: () => void;
  replayUrl: string | null;
}) {
  return (
    <>
      <span className="qrp-spacer" />
      <button
        className="qrp-rate qrp-tip"
        type="button"
        data-tip="Playback speed"
        aria-label={`Playback speed ${String(baseRate)}x`}
        onClick={onCycleRate}
      >
        {String(baseRate)}×
      </button>
      {replayUrl ? (
        <a className="qrp-button qrp-tip" href={artifactDownloadUrl(replayUrl)} download data-tip="Download video (captions, cursor, smart pacing)" aria-label="Download video">
          <Download aria-hidden="true" />
        </a>
      ) : null}
      <button
        className="qrp-button qrp-tip"
        type="button"
        data-tip="Fullscreen"
        aria-label="Toggle fullscreen"
        onClick={onToggleFullscreen}
      >
        <Maximize aria-hidden="true" />
      </button>
    </>
  );
}
