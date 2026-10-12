/**
 * What a conversation's turn asks on its owner's behalf (store/host-requests-for-job.ts,
 * store/draft-keep-for-job.ts, store/walks.ts): start a verification, set or
 * clear a schedule, remove a Journey, keep or discard a walk's drafts, walk
 * and keep or discard the staged edits (store/edits-for-job.ts), start a walk
 * and answer the question a walk waits on. Only the
 * chat's own tools hold it (conversation-turn/tools.ts); no Sandbox does, so
 * none of it is on the job API.
 */
import type { JobStore } from "./store/job-store.ts";

export interface HostRequestStore {
  startVerificationForJob: JobStore["startVerificationForJob"];
  setSuiteScheduleForJob: JobStore["setSuiteScheduleForJob"];
  removeFromSuiteForJob: JobStore["removeFromSuiteForJob"];
  decideDraftsForJob: JobStore["decideDraftsForJob"];
  verifyEditsForJob: JobStore["verifyEditsForJob"];
  decideEditsForJob: JobStore["decideEditsForJob"];
  startWalkForJob: JobStore["startWalkForJob"];
  answerWalkQuestionForJob: JobStore["answerWalkQuestionForJob"];
}
