"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import type { BrowserRecordingViewModel } from "@shipbash/contracts/api/view-types";
import type { AgentPointerSignal } from "./agent-cursor";
import {
  browserRecordingActiveCaption,
  browserRecordingPlaybackRate,
  browserRecordingReplayPointer,
} from "./browser-recording-player-model";

const PLAYBACK_RATES = [1, 1.5, 2, 4];

/**
 * The player's transport: the elements it drives, the playhead state it mirrors
 * out of the video, and every control the chrome binds to. The video element is
 * the single source of truth; `sync` reads it after each transport change.
 */
export function useBrowserRecordingPlayer({
  onVideo,
  recording,
}: {
  /** Told about the element itself, for a page that keeps its own clock. */
  onVideo?: ((video: HTMLVideoElement | null) => void) | undefined;
  recording: BrowserRecordingViewModel;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // The walk the reader has actually started. The cover belongs to a picture
  // nobody has played: once this one runs, a later pause is a pause and the
  // frame stays uncovered — and another walk, whose id this is not, is covered
  // again.
  const [startedId, setStartedId] = useState<string | null>(null);
  const [baseRate, setBaseRate] = useState(1);
  const [currentMs, setCurrentMs] = useState(0);
  const [activeRate, setActiveRate] = useState(1);
  const [caption, setCaption] = useState<string | null>(null);
  const [pointer, setPointer] = useState<AgentPointerSignal | null>(null);

  const pointers = recording.pointers ?? [];
  const cues = recording.cues ?? [];
  const speedSegments = recording.speedSegments ?? [];
  const durationMs = recording.durationMs;

  const letterbox = useLetterboxWidth(recording.width / recording.height);

  // The element goes through a callback ref so a page outside the player can
  // hear about it. The ref object stays the transport's own handle: a
  // callback ref cannot be read back.
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    onVideo?.(node);
  }, [onVideo]);

  const attachCard = useCallback((node: HTMLElement | null) => {
    cardRef.current = node;
  }, []);

  const sync = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const timeMs = Math.round(video.currentTime * 1_000);
    setCurrentMs(timeMs);
    setPlaying(!video.paused && !video.ended);
    if (!video.paused) setStartedId(recording.id);
    // Static stretches never play slower than the viewer's chosen speed.
    const nextRate = Math.max(
      baseRate,
      browserRecordingPlaybackRate(timeMs, speedSegments),
    );
    if (video.playbackRate !== nextRate) video.playbackRate = nextRate;
    setActiveRate(nextRate);
    setPointer((current) => {
      const next = browserRecordingReplayPointer(timeMs, pointers);
      return current?.id === next?.id ? current : next;
    });
    setCaption(browserRecordingActiveCaption(timeMs, cues));
  }, [baseRate, cues, pointers, recording.id, speedSegments]);

  useEffect(() => {
    sync();
    return () => {
      const video = videoRef.current;
      if (video) video.playbackRate = 1;
    };
  }, [sync]);

  const transport = useRecordingTransport({ cardRef, durationMs, setBaseRate, sync, timelineRef, videoRef });

  return {
    ...letterbox,
    ...transport,
    activeRate,
    attachCard,
    attachVideo,
    baseRate,
    caption,
    currentMs,
    durationMs,
    playing,
    pointer,
    pointers,
    speedSegments,
    started: startedId === recording.id,
    sync,
    timelineRef,
    videoRef,
  };
}

/**
 * The browser window — its chrome over the video — keeps the video's aspect
 * ratio; size it to the widest fit inside the cinema, leaving the leftover as
 * the letterbox backdrop.
 */
function useLetterboxWidth(videoAspect: number) {
  const cinemaRef = useRef<HTMLDivElement>(null);
  const [windowWidth, setWindowWidth] = useState<number | null>(null);

  useEffect(() => {
    const cinema = cinemaRef.current;
    if (!cinema || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // The chrome's height belongs to the CSS that draws it; a copy here drifts.
      const chrome = getComputedStyle(cinema).getPropertyValue("--browser-mockup-chrome-height");
      const headerPx = Number.parseFloat(chrome) || 0;
      setWindowWidth(Math.max(1, Math.min(
        cinema.clientWidth,
        Math.floor((cinema.clientHeight - headerPx) * videoAspect),
      )));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cinema);
    return () => observer.disconnect();
  }, [videoAspect]);

  return { cinemaRef, windowWidth };
}

/** Play, seek, scrub, speed and fullscreen, each re-reading the video after. */
function useRecordingTransport({
  cardRef,
  durationMs,
  setBaseRate,
  sync,
  timelineRef,
  videoRef,
}: {
  cardRef: RefObject<HTMLElement | null>;
  durationMs: number;
  setBaseRate: (update: (current: number) => number) => void;
  sync: () => void;
  timelineRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play();
    else video.pause();
  }, [videoRef]);

  const seekBy = useCallback((deltaSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(
      Math.max(0, video.currentTime + deltaSeconds),
      durationMs / 1_000,
    );
    sync();
  }, [durationMs, sync, videoRef]);

  const seekToStart = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    sync();
  }, [sync, videoRef]);

  const seekToMs = useCallback((milliseconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, milliseconds), durationMs) / 1_000;
    sync();
  }, [durationMs, sync, videoRef]);

  const toggleFullscreen = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void card.requestFullscreen();
  }, [cardRef]);

  const seekFromPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const timeline = timelineRef.current;
    const video = videoRef.current;
    if (!timeline || !video || durationMs <= 0) return;
    const rect = timeline.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    video.currentTime = (fraction * durationMs) / 1_000;
    sync();
  }, [durationMs, sync, timelineRef, videoRef]);

  const handleTimelineDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  }, [seekFromPointer]);

  const handleTimelineMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.buttons & 1) seekFromPointer(event);
  }, [seekFromPointer]);

  const cycleRate = useCallback(() => {
    setBaseRate((current) => {
      const index = PLAYBACK_RATES.indexOf(current);
      return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length] ?? 1;
    });
  }, [setBaseRate]);

  return {
    cycleRate,
    handleTimelineDown,
    handleTimelineMove,
    seekBy,
    seekToMs,
    seekToStart,
    toggleFullscreen,
    togglePlay,
  };
}
