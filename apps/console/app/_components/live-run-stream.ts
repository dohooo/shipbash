import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";
import type { RunEventView } from "@shipbash/contracts/api/view-types";
import type { SuiteRunStatus } from "@shipbash/contracts/database-contract-types";
import { CHECKLIST_STATUSES } from "@shipbash/contracts/runtime/checklist-contract.mjs";
import {
	PUBLIC_CASE_RUNS_STATUS_VALUES,
	PUBLIC_CASE_RUNS_VERDICT_VALUES,
	PUBLIC_SUITE_RUNS_STATUS_VALUES,
} from "@shipbash/contracts/runtime/generated/db-vocabularies.mjs";
import { isRecord } from "../../lib/is-record";
import type { AgentPointerSignal } from "./agent-cursor";

export function streamPointer(
	value: unknown,
	id: string,
): AgentPointerSignal | null {
	if (!isRecord(value)) return null;
	const x = Number(value.x);
	const y = Number(value.y);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return {
		id,
		action: typeof value.action === "string" ? value.action : "click",
		x,
		y,
	};
}

export function latestPointerSignal(
	events: readonly RunEventView[],
): AgentPointerSignal | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.pointer)
			return streamPointer(
				event.pointer,
				event.id || `pointer-${String(index)}`,
			);
	}
	return null;
}

export const RUN_STATUSES = new Set(PUBLIC_SUITE_RUNS_STATUS_VALUES);
export const CASE_STATUSES = new Set(PUBLIC_CASE_RUNS_STATUS_VALUES);
export const VERDICTS = new Set(PUBLIC_CASE_RUNS_VERDICT_VALUES);
function isChecklistStatus(
	value: unknown,
): value is CaseChecklistItem["status"] {
	return typeof value === "string" && CHECKLIST_STATUSES.has(value);
}

export function isTerminal(status: SuiteRunStatus): boolean {
	return status === "completed" || status === "canceled";
}

const ARTIFACT_HREF =
	/^\/api\/projects\/[^/?#]+\/verifications\/[^/?#]+\/artifacts\/[^/?#]+$/u;
const PUBLIC_SCREENSHOT_HREF =
	/^\/api\/public\/verifications\/[A-Za-z0-9_-]{43}\/media\/[a-f0-9]{64}\/screenshot$/u;

export function safeArtifactHref(value: string | null): string | null {
	return value && ARTIFACT_HREF.test(value) ? value : null;
}

export function safePublicScreenshotHref(value: string | null): string | null {
	return value && PUBLIC_SCREENSHOT_HREF.test(value) ? value : null;
}

export function redact(value: unknown): string {
	return String(value == null ? "" : value)
		.replace(
			/(authorization|cookie|set-cookie|password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
			"$1=[redacted]",
		)
		.replace(/([?&](?:token|code|key|secret)=)[^&#\s]+/gi, "$1[redacted]")
		.slice(0, 280);
}

export function eventTimestamp(value: unknown): string {
	const date = value ? new Date(String(value)) : new Date();
	return Number.isNaN(date.getTime())
		? new Date().toISOString()
		: date.toISOString();
}

function eventSortTime(timestamp: string): number {
	const time = new Date(timestamp).getTime();
	return Number.isNaN(time) ? 0 : time;
}

/**
 * Browser stream events only exist in this client, so they are kept outside
 * the polled run view and interleaved at render time; a background refetch
 * must never wipe rows the person is reading.
 */
export function mergeEventTimelines(
	persisted: readonly RunEventView[],
	browser: readonly RunEventView[],
): RunEventView[] {
	if (browser.length === 0) return [...persisted];
	const stamped = [
		...persisted.map((event, index) => ({
			event,
			time: eventSortTime(event.timestamp),
			order: index,
		})),
		...browser.map((event, index) => ({
			event,
			time: eventSortTime(event.timestamp),
			order: persisted.length + index,
		})),
	];
	stamped.sort(
		(left, right) => left.time - right.time || left.order - right.order,
	);
	return stamped.map((entry) => entry.event);
}

export function elapsedLabel(timestamp: string, origin: string): string {
	const elapsed = Math.max(
		0,
		new Date(timestamp).getTime() - new Date(origin).getTime(),
	);
	if (!Number.isFinite(elapsed)) return "—";
	const totalSeconds = Math.floor(elapsed / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function streamArtifacts(
	value: unknown,
): NonNullable<RunEventView["artifacts"]> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		if (!isRecord(candidate)) return [];
		return [
			{
				kind: redact(candidate.kind ?? "manifest"),
				label: redact(candidate.label ?? "Artifact"),
				url: safeArtifactHref(
					typeof candidate.url === "string" ? candidate.url : null,
				),
			},
		];
	});
}

// packages/contracts/src/runtime/checklist-contract.mjs copy, split on purpose:
// an untrusted stream is sliced to 5 items and offending items are dropped, never thrown on.
export function streamChecklist(value: unknown): CaseChecklistItem[] | null {
	if (!Array.isArray(value)) return null;
	const ids = new Set<string>();
	return value.slice(0, 5).flatMap((entry) => {
		if (!isRecord(entry)) return [];
		if (
			typeof entry.id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(entry.id) ||
			ids.has(entry.id)
		)
			return [];
		if (typeof entry.goal !== "string" || entry.goal.trim().length === 0)
			return [];
		if (!isChecklistStatus(entry.status)) return [];
		const reason =
			typeof entry.reason === "string" && entry.reason.trim()
				? redact(entry.reason)
				: null;
		if (reason && entry.status !== "failed" && entry.status !== "blocked")
			return [];
		ids.add(entry.id);
		return [
			{
				id: entry.id,
				goal: redact(entry.goal),
				status: entry.status,
				reason,
			},
		];
	});
}

export function parseEventKind(
	value: unknown,
): RunEventView["kind"] {
	return value === "action" || value === "result" || value === "console"
		? value
		: "system";
}

export function parseEventLevel(
	value: unknown,
): NonNullable<RunEventView["level"]> {
	return value === "warning" || value === "error" ? value : "info";
}

/**
 * Explains what the run is actually doing before the first checklist report,
 * so the initial startup window does not read as an idle queue.
 */
export function startupStageMessage(
	events: readonly RunEventView[],
): string {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const type = events[index]?.eventType;
		if (type === "runner_retrying") {
			return "A transient environment failure occurred. The Runner is retrying automatically…";
		}
		if (type?.startsWith("agent_action")) {
			return "The Agent is working. Verification goals appear after its first trustworthy observation.";
		}
		if (type === "browser_stream_ready") {
			return "Browser is live. The Agent is reading the Journey…";
		}
		if (
			type === "suite_started" ||
			type === "case_started" ||
			type === "case_attempt_started"
		) {
			return "The Runner is starting the browser…";
		}
	}
	return "Waiting for a Runner to pick up this run…";
}
