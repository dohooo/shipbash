/**
 * The event vocabulary both sides of the runner boundary speak.
 *
 * The diagnostic contract failure-shaped run events carry: the container
 * decides what to record at the moment of failure; the host allowlist decides
 * what survives into the store. Both read this file, so a field added at one
 * end can no longer be silently dropped at the other.
 *
 * The Activity vocabularies live here for the same reason: the container
 * emitter, the host NDJSON parser, and the browser client each gate events
 * by kind, and a kind added to one gate but not the others is an event that
 * silently dies mid-channel.
 */

import { PUBLIC_ACTIVITY_EVENTS_KIND_VALUES } from "./generated/db-vocabularies.mjs";

/** What one Activity event IS: the emitter's and every gate's shared kinds. */
export const ACTIVITY_EVENT_KINDS = PUBLIC_ACTIVITY_EVENTS_KIND_VALUES;

export const DIAGNOSTIC_EVENT_TYPES = Object.freeze([
	"case_infrastructure_error",
	"infrastructure_error",
	"artifact_capture_failed",
	"browser_cleanup_failed",
	"auth_candidate_missing",
	"human_auth_state_capture_failed",
]);

export const DIAGNOSTIC_EVENT_FIELDS = Object.freeze([
	"command",
	"exitCode",
	"signal",
	"timedOut",
	"durationMs",
	"stderrTail",
	"responseError",
	"browserProcesses",
	"shmBytes",
	"kind",
]);
