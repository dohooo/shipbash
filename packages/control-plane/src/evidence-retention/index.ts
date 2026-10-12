/**
 * One way to keep a run's evidence, for both lanes: the task walks its files
 * and hashes them, the job API signs each upload and derives its path, the
 * task puts the bytes, and the server checks the objects and writes the rows
 * and their announcements. A Sandbox passes its remote port; the local lane
 * passes its own (local-port.ts).
 */
export { ACTIVITY_FINAL_SCREENSHOT_FILE, retainActivityEvidence } from "./activity.ts";
export { failCaseRecording, retainCaseRecording } from "./recording.ts";
export { retainSuiteEvidence } from "./suite.ts";
