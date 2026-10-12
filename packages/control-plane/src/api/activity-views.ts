/**
 * The Activity read-model: the Activity as its page shows it, which the
 * Activity page reads and an evidence bundle keeps as activity.json. Split
 * from views.ts along the resource seam, as run-views.ts is for runs; it is
 * not re-exported there, since the review and steer helpers it builds on
 * import views.ts themselves.
 */
import type { getActivityContract } from "@shipbash/contracts/api/activities";
import type { ApiContractResponse } from "@shipbash/contracts/api/core";
import { browserStreamUrlFromMetadata } from "@shipbash/contracts/browser-connection-url";
import { retryableActivity } from "../store/activity-retry.ts";
import { activityReview } from "./activity-review.ts";
import { takesSteer } from "./activity-steer.ts";
import type { StoreActivityDetail, StoreProposal } from "./gateways.ts";
import type { RouteContext } from "./route-support.ts";
import { activityEventView, activityView, emptyProposalViewInputs, loadProposalViewInputs, proposalView } from "./views.ts";

/** The Activity as its page shows it: what the page reads, and what an evidence bundle keeps as activity.json. */
export async function activityPageView(
  context: RouteContext,
  scope: { teamId: string; projectId: string },
  detail: StoreActivityDetail,
): Promise<ApiContractResponse<typeof getActivityContract>> {
  const { actor, options } = context;
  const { teamId, projectId } = scope;
  const activityId = detail.activity.id;
  const proposals = (
    await Promise.all((detail.result?.proposalIds ?? []).map((proposalId) => options.store.getProposal(actor, teamId, projectId, proposalId)))
  ).filter((proposal): proposal is StoreProposal => proposal !== null);
  // Suite names and the initial-proposal scan exist only to label proposals;
  // for the whole polling lifetime of a running Activity, proposals is empty
  // and the cross-activity scan would be discarded work on every request.
  const viewInputs = proposals.length ? await loadProposalViewInputs(options.store, actor, teamId, projectId, proposals) : emptyProposalViewInputs();
  const hasFinalScreenshot = [...detail.events]
    .reverse()
    .some((event) => event.safeData.event === "activity_final_screenshot" && typeof event.safeData.artifactObjectPath === "string");
  // The stream address rides as its own field so the live view never has to
  // scan the event list for it.
  const streamEvent = [...detail.events].reverse().find((event) => event.safeData.event === "browser_stream_ready");
  return {
    ...activityView(detail.activity),
    review: await activityReview(context, scope, detail, proposals, viewInputs),
    pendingQuestion: detail.activity.status === "waiting_for_input"
      ? await options.store.unansweredActivityQuestion(actor, teamId, projectId, activityId)
      : null,
    steerable: takesSteer(detail.activity),
    retryable: retryableActivity(detail.activity.status),
    wrapUpRequestedAt: detail.wrapUpRequestedAt,
    finalScreenshotUrl:
      options.artifacts && hasFinalScreenshot
        ? `/api/projects/${encodeURIComponent(projectId)}/activities/${encodeURIComponent(activityId)}/final-screenshot`
        : null,
    streamUrl: browserStreamUrlFromMetadata(streamEvent?.safeData),
    streamRevision: detail.events.filter((event) => event.safeData.event === "browser_stream_ready").length,
    // Same reason as streamUrl: the retained terminal logs are a field of
    // their own, not something the console digs out of the events.
    terminalLogSessionIds: [
      ...new Set(
        detail.events.flatMap((event) =>
          event.safeData.event === "activity_terminal_log" && typeof event.safeData.sessionId === "string" ? [event.safeData.sessionId] : [],
        ),
      ),
    ],
    // Every event, no tail: the conversation is read from this list, and a
    // window dropped the reader's own steers and the replies between them
    // once a long run pushed them out.
    events: detail.events.map(activityEventView),
    result: detail.result
      ? {
          kind: detail.result.kind,
          summary: detail.result.summary,
          attentionCode: detail.result.attentionCode,
          recoveryAction: detail.result.recoveryAction,
          proposals: proposals.map((proposal) => proposalView(proposal, viewInputs)),
        }
      : null,
  };
}
