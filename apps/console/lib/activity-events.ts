/**
 * The live activity-event channel, as the browser sees it.
 *
 * Events arrive over SSE from a server that has already redacted and bounded
 * them, and are re-validated here anyway: this code runs in a page that any
 * script on the origin can reach, and a feed that renders whatever it is handed
 * is a feed that can be told to render anything.
 *
 * Merging is by sequence, not arrival: the stream and the polling refetch race,
 * and an event applied twice would double an entry in the reader's flow.
 */
import { browserStreamUrlFromMetadata } from "@shipbash/contracts/browser-connection-url";
import {
	boundedSafeData,
	safeDataFieldLimit,
} from "@shipbash/contracts/runtime/activity-safe-data.mjs";
import { activityEventClientFrameSchema } from "@shipbash/contracts/api/streams";
import type {
	ActivityDetail,
	ActivityEvent,
	ActivityStreamEvent,
} from "./web-client";

// This hop's own censoring list — narrower than the host patterns (no
// credential/passwd/object-path terms) because the server has already
// redacted; widening it is a behavior change.
const sensitiveActivityDataKey = /authorization|cookie|password|secret|token/iu;

function boundedActivitySafeData(value: unknown): ActivityEvent["safeData"] {
	return boundedSafeData(value, {
		sensitiveKeyPattern: sensitiveActivityDataKey,
		// No redaction here: the payload arrives server-redacted; this hop only
		// re-bounds what an origin script could have injected.
		transformString: (entry, key) => entry.slice(0, safeDataFieldLimit(key)),
	});
}

export function activityEventStreamUrl(
	projectId: string,
	activityId: string,
	afterSequence: number,
): string {
	const after =
		Number.isSafeInteger(afterSequence) && afterSequence >= 0
			? afterSequence
			: 0;
	const path = ["projects", projectId, "activities", activityId, "events"]
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `/api/${path}?after=${String(after)}`;
}

export function parseActivityStreamEvent(
	data: string,
): ActivityStreamEvent | null {
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	const parsed = activityEventClientFrameSchema.safeParse(value);
	if (!parsed.success) return null;
	const record = parsed.data;
	return {
		id: record.id.slice(0, 200),
		sequence: record.sequence,
		kind: record.kind,
		status: record.status,
		label: record.label.slice(0, 500),
		bodyMarkdown: record.bodyMarkdown?.slice(0, 20_000) ?? null,
		safeData: boundedActivitySafeData(record.safeData),
		createdAt: record.createdAt.slice(0, 100),
	};
}

export function mergeActivityStreamEvent(
	detail: ActivityDetail,
	event: ActivityStreamEvent,
): ActivityDetail {
	const bySequence = new Map(
		detail.events.map((entry) => [entry.sequence, entry]),
	);
	const fresh = !bySequence.has(event.sequence);
	if (fresh) {
		const { status: _status, ...durableEvent } = event;
		bySequence.set(event.sequence, durableEvent);
	}
	// A resumed or retried leg streams from a fresh endpoint. The page must
	// follow the re-announcement or it keeps dialing the dead port forever —
	// the frozen-browser, frozen-terminal page a woken run used to leave.
	const announcedStreamUrl =
		fresh && event.safeData?.event === "browser_stream_ready"
			? browserStreamUrlFromMetadata(event.safeData)
			: null;
	return {
		...detail,
		...(announcedStreamUrl
			? {
					streamUrl: announcedStreamUrl,
					streamRevision: detail.streamRevision + 1,
				}
			: {}),
		status: event.status,
		updatedAt: event.createdAt,
		events: [...bySequence.values()].sort((left, right) => left.sequence - right.sequence),
	};
}
