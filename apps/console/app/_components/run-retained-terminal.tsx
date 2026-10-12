"use client";

/**
 * A finished walk's sandbox shell, replayed from the session logs the run
 * retained. The live workbench and the run report both show a finished case
 * this way, so the hydration path exists once: the lane hook reads the same
 * ndjson the runner wrote, and the panel below it is the one the Discovery
 * page wears.
 *
 * Given a playhead and the recording's clock, the logs play at the pace they
 * ran, in step with the recording's video. Without them — the report's
 * static panel, or a case whose recording never landed — each log arrives
 * whole, which is all a page with no playhead can do with it.
 */
import { useEffect, useState } from "react";

import type { RecordingClock } from "@shipbash/contracts/runtime/recording-clock.mjs";
import { ActivityTerminal, type RetainedTerminalLog, useTerminalLane } from "./activity-terminal";
import type { RunReplayClock } from "./run-replay-clock";
import { createTerminalReplayFeed } from "./terminal-replay";

export function RunRetainedTerminal({
	logs,
	activeSessionId = null,
	timeAt = null,
	clock = null,
}: {
	logs: readonly RetainedTerminalLog[];
	/** The shell the recorded attention track says the agent was last in. */
	activeSessionId?: string | null;
	/**
	 * The recording's own clock, which places each shell's output on the video.
	 * Read once, when the panel mounts: the host keys the panel by recording.
	 */
	timeAt?: RecordingClock | null;
	/** The playhead the sessions follow. */
	clock?: RunReplayClock | null;
}) {
	// The feed is bound once — each screen subscribes when its wterm is ready,
	// the lane loads each session into it once — so it lives as long as the
	// panel. Its clock is read once for the same reason, and that is safe: a
	// recording's anchors are fixed once it is available, and a different
	// recording remounts the panel.
	const [replayFeed] = useState(() => (timeAt ? createTerminalReplayFeed(timeAt) : null));
	useEffect(() => {
		if (!replayFeed || !clock) return;
		replayFeed.seek(clock.currentMs());
		return clock.subscribe((currentMs) => {
			replayFeed.seek(currentMs);
		});
	}, [clock, replayFeed]);
	const { sessions, feed } = useTerminalLane(logs, replayFeed);
	return (
		<ActivityTerminal
			sessions={sessions}
			feed={feed}
			live={false}
			input={null}
			activeSessionId={activeSessionId}
		/>
	);
}
