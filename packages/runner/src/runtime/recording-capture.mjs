// One walk's recording as the runner captures it: the browser video and every
// track the replay is assembled from — the narration's captions, the agent's
// pointers, where its attention went, the shells it opened and the Journeys
// it marked. A Journey's attempt (suite-runner/case-attempt.mjs) and a walk's
// leg (activity-runner/walk-recording.mjs) each make one and only forward
// their events to it; the finalizer assembles what it captured
// (recording-finalize.mjs), a case run walked twice once its walks are joined
// (joinWalk).
//
// Every moment is kept as an epoch read off the recording's one clock
// (recording-now.mjs), which the stream recorder and the terminal lane read too, so
// a frame, a caption, a call and a shell's output are placed against each
// other without a wall-clock step moving one of them. The video's own clock
// (contracts recording-clock.mjs) places each on the video.
//
// The segment opens before the recorder joins the sidecar, because the
// sidecar hands a joining recorder its last frame at once and that frame is
// the video's t=0. Its anchor is the moment the recorder's first frame took
// slot 0, as the recorder read it (`onFirstFrame`): on a busy Sandbox that
// came 4–6 s after the start, and cues timed from the start ran that far
// behind the picture they describe. A caption or pointer captured while no
// segment is open is dropped, and a capture whose segment never painted has
// no video for any of them to be on.
import { AGENT_POINTER_ACTIONS } from "@shipbash/contracts/runtime/agent-pointer-actions.mjs";
import { MAX_RECORDING_CUES, MAX_RECORDING_POINTERS, POINTER_LEAD_MS } from "@shipbash/contracts/runtime/recording-bounds.mjs";

import { createAttentionCollector } from "./attention-collector.mjs";
import { startBrowserStreamRecording } from "./browser-stream-recording.mjs";
import { nonEmptyFile } from "./recording-command.mjs";
import { recordingNow } from "./recording-now.mjs";

/**
 * A segment of a recording, as the capture wrote it: its file, the moment on
 * the recording's clock its first frame took slot 0 (null when it never
 * painted), and the walk that wrote it with the outcome that walk ended on
 * (joinWalk numbers a case run's walks; a walk's own recording is walk 1).
 * @typedef {{ path: string, startedAtEpochMs: number | null, walk: number, outcome: string | null }} RecordedSegment
 */
/**
 * A recording as the runner captured it, one walk's or a case run's joined
 * walks, every moment an epoch on the recording's clock (recording-now.mjs): what
 * the finalizer assembles (recording-finalize.mjs). Nothing in it comes from
 * outside the runner unread: narration is checked by its channel's reader
 * (recording-narration.mjs), and everything else is the runner's own. A
 * walk's recording also carries the Journeys it marked, the start of each
 * call that drew attention, and `endedAt`, where a Journey still open ends
 * (recording-journeys.mjs).
 * @typedef {{
 *   segments: RecordedSegment[],
 *   narrationEvents: Array<{ caption: string, chapterId: string, chapterTitle: string, epochMs: number, sequence: number }>,
 *   pointerEvents: Array<{ action: string, x: number, y: number, epochMs: number, sequence: number }>,
 *   attention: Array<{ atMs: number, answeredAtMs: number, surface: "browser" | "terminal", sessionId: string | null, label: string | null }>,
 *   terminalSessions: Array<{ sessionId: string, title: string, startedAtMs: number, logPath?: string }>,
 *   marks: Array<{ title: string, startedAt: number, endedAt: number | null }>,
 *   steps: number[],
 *   endedAt: number,
 * }} Recording
 */

/**
 * @param {{ outputPath: string, redact: (value: string) => unknown, terminalLane: () => { sessions(): Recording["terminalSessions"] } | null }} io
 *   `outputPath` is the segment the recorder writes; `terminalLane` the lane whose shells the walk opens.
 * @param {() => number} [now] the recording's clock
 */
export function createRecordingCapture({ outputPath, redact, terminalLane }, now = recordingNow) {
  const sessions = () => terminalLane()?.sessions() ?? [];
  const attention = createAttentionCollector({ redact, newestTerminalSessionId: () => sessions().at(-1)?.sessionId ?? null });
  let open = false;
  let startedAtEpochMs = null;
  let recorder = null;
  const cues = [];
  const pointers = [];
  const marks = [];
  const steps = [];
  const painted = (entries) => (startedAtEpochMs === null ? [] : [...entries]);
  return {
    /** Opens the segment and joins the recorder to the sidecar on `upstreamPort`; one that cannot start closes it again and throws. */
    async start({ upstreamPort }) {
      open = true;
      try {
        recorder = await startBrowserStreamRecording({
          upstreamPort,
          outputPath,
          now,
          onFirstFrame: (atMs) => {
            if (open && startedAtEpochMs === null) startedAtEpochMs = atMs;
          },
        });
      } catch (error) {
        open = false;
        throw error;
      }
    },
    /** The recorder's own stop, then the segment's; throws what the recorder's close threw. */
    async stop() {
      const stopping = recorder;
      recorder = null;
      try {
        await stopping?.close();
      } finally {
        open = false;
      }
    },
    /** One narration line, already read as the narration rule allows (recording-narration.mjs), where it was said. */
    caption({ caption, chapterId, chapterTitle }) {
      if (!open || cues.length >= MAX_RECORDING_CUES) return;
      cues.push({ caption, chapterId, chapterTitle, epochMs: now(), sequence: cues.length + 1 });
    },
    /**
     * One pointer the browser proxy published, now: the proxy resolves its
     * coordinates before it forwards the action, so the moment it is read is
     * the action's, and the pointer is placed the lead the replay's cursor
     * flies in before it.
     */
    point(pointer) {
      if (!open || pointers.length >= MAX_RECORDING_POINTERS) return;
      const x = Number(pointer?.x);
      const y = Number(pointer?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      pointers.push({
        // The document keeps the one vocabulary (agent-pointer-actions.mjs), as the pointer channel does.
        action: AGENT_POINTER_ACTIONS.find((known) => known === (typeof pointer.action === "string" ? pointer.action.trim() : "")) ?? "click",
        x,
        y,
        epochMs: now() - POINTER_LEAD_MS,
        sequence: pointers.length + 1,
      });
    },
    /**
     * One completed browser or terminal call, `ms` long, answered now: where
     * the attention went (attention-collector.mjs), from the moment the call
     * started. The start of every call that drew it is a step, where a
     * Journey's span opens (recording-journeys.mjs journeySpans).
     * @param {{ tool?: unknown, arguments?: unknown, actionId?: unknown, sessionId?: unknown, ms: number }} call
     */
    action({ ms, ...call }) {
      const answeredAtMs = now();
      const startedAtMs = answeredAtMs - ms;
      const drew = attention.record({ ...call, startedAtMs, answeredAtMs });
      if (drew) steps.push(startedAtMs);
      return drew;
    },
    /** One edge of a Journey the walk marked (mark_journey), now: a start opens a span, an end closes the open one. */
    mark({ edge, title }) {
      const atMs = now();
      const last = marks.at(-1);
      if (edge === "start") marks.push({ title, startedAt: atMs, endedAt: null });
      else if (last && last.endedAt === null) last.endedAt = atMs;
    },
    /**
     * What the walk captured, as the finalizer reads it (Recording): its
     * segment if the recorder wrote one, every track, and the marks and steps
     * with `endedAt`, now, where a Journey still open ends.
     */
    async recorded() {
      return {
        segments: (await nonEmptyFile(outputPath)) ? [{ path: outputPath, startedAtEpochMs, walk: 1, outcome: null }] : [],
        narrationEvents: painted(cues),
        pointerEvents: painted(pointers),
        attention: attention.snapshot(),
        terminalSessions: sessions(),
        marks,
        steps,
        endedAt: now(),
      };
    },
  };
}

/**
 * A case run's recording with one more walk joined. One case run means one
 * assembled video, so a retry adds its segments and tracks to the same
 * recording, each segment numbered for the walk that produced it and the
 * outcome that walk ended on, which is what lets the finalizer chapter the
 * boundary the viewer otherwise cannot see (recording-walks.mjs). A case run
 * marks no Journeys (it is one), so it carries no marks or steps, and ends
 * where its last walk did.
 * @param {(Recording & { attempt: number }) | undefined} joined the case run's recording so far
 * @param {Recording} recorded
 * @param {{ attempt: number, outcome: string | null }} walk
 * @returns {Recording & { attempt: number }}
 */
export function joinWalk(joined, recorded, { attempt, outcome }) {
  const recording = joined ?? {
    attempt, segments: [], narrationEvents: [], pointerEvents: [], attention: [], terminalSessions: [], marks: [], steps: [], endedAt: 0,
  };
  const walk = (recording.segments.at(-1)?.walk ?? 0) + 1;
  recording.segments.push(...recorded.segments.map((segment) => ({ ...segment, walk, outcome })));
  recording.narrationEvents.push(...recorded.narrationEvents);
  recording.pointerEvents.push(...recorded.pointerEvents);
  recording.attention.push(...recorded.attention);
  recording.terminalSessions.push(...recorded.terminalSessions);
  recording.endedAt = recorded.endedAt;
  return recording;
}
