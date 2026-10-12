/** Activity route dispatcher. Endpoint behavior lives in focused handlers. */
import { firstHandled } from "./route-handler.ts";
import {
  handleActivityAction,
  handleActivityCreation,
  handleActivityInteraction,
} from "./routes-activity-writes.ts";
import {
  handleActivityDetail,
  handleActivityEvents,
  handleActivityFinalScreenshot,
  handleActivityRecording,
  handleActivityTerminalLog,
} from "./routes-activity-reads.ts";

export const handleActivities = firstHandled(
  handleActivityCreation,
  handleActivityAction,
  handleActivityInteraction,
  handleActivityDetail,
  handleActivityRecording,
  handleActivityFinalScreenshot,
  handleActivityTerminalLog,
  handleActivityEvents,
);
