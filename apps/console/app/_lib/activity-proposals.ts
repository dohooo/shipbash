/**
 * The Journey candidates an Activity has proposed, flattened for display.
 *
 * A run can carry several proposals and each carries several candidates, but
 * the workbench shows one list. `sequence` preserves the order the agent
 * proposed them in across that flattening.
 */
import { isRecord } from "@/lib/is-record";
import { journeyCheckpointGoal, journeyStepInstruction, type ActivityDetail } from "@/lib/web-client";
import { type CaseRole, type OwnerConfirmation, readCaseRole, readOwnerConfirmation } from "./case-slot";

export interface ActivityCandidateCase {
  id: string;
  title: string;
  steps: string;
  category: string;
  whyItMatters: string | null;
  preconditions: string[];
  checkpoints: string[];
  /** A Journey, or the slot of a setup/teardown hook around the run. */
  role: CaseRole;
  /** Whether a proposed hook still waits for the owner's nod. */
  ownerConfirmation: OwnerConfirmation;
  sequence: number;
}

/** What the workbench's journeys pane reads off a candidate. */
export type AgentChatJourney = Pick<
  ActivityCandidateCase,
  "id" | "title" | "category" | "role" | "whyItMatters" | "preconditions" | "steps" | "checkpoints"
>;

/**
 * The live list while the agent is still walking, derived from the
 * journey_upsert / journey_removed events the journey tools emit. Once the
 * round completes, the persisted proposal is authoritative and this yields
 * to it. (The event feed carries the last 300 events, so a very long round
 * can age the earliest additions out of the live view; the completed
 * proposal restores them.)
 */
function liveCandidateCases(activity: ActivityDetail): ActivityCandidateCase[] {
  const live = new Map<string, Record<string, unknown>>();
  for (const event of activity.events) {
    const data = event.safeData;
    if (data.event === "journey_upsert" && typeof data.journeyId === "string" && typeof data.journeyJson === "string") {
      try {
        const journey: unknown = JSON.parse(data.journeyJson);
        if (isRecord(journey)) live.set(data.journeyId, journey);
      } catch {
        // A malformed payload only costs the live row; the proposal restores it.
      }
    } else if (data.event === "journey_removed" && typeof data.journeyId === "string") {
      live.delete(data.journeyId);
    }
  }
  return [...live.values()].map((journey, index) => {
    const steps = Array.isArray(journey.steps) ? journey.steps.map(String) : [];
    const checkpoints = Array.isArray(journey.checkpoints)
      ? journey.checkpoints.map((checkpoint) => String(isRecord(checkpoint) ? checkpoint.goal ?? "" : ""))
      : [];
    return {
      id: String(journey.id ?? index),
      title: String(journey.title ?? ""),
      steps: steps.join("\n"),
      category: String(journey.category ?? "Core product"),
      whyItMatters: typeof journey.whyItMatters === "string" ? journey.whyItMatters : null,
      preconditions: Array.isArray(journey.preconditions) ? journey.preconditions.map(String) : [],
      checkpoints,
      role: readCaseRole(journey.role),
      ownerConfirmation: readOwnerConfirmation(journey.ownerConfirmation),
      sequence: index,
    };
  });
}

export function activityCandidateCases(activity: ActivityDetail): ActivityCandidateCase[] {
  const persisted = (activity.result?.proposals ?? []).flatMap((proposal, proposalIndex) => (
    proposal.candidateDefinition.flatMap((candidate, caseIndex) => {
      // An approved Journey the change leaves as it is is not the agent's candidate.
      if (candidate.archived || (candidate.id !== undefined && proposal.unchangedCaseIds.includes(candidate.id))) return [];
      const steps = typeof candidate.steps === "string"
        ? candidate.steps
        : candidate.steps.map(journeyStepInstruction).join("\n");
      return [{
        id: `${proposal.id}:${candidate.id ?? String(caseIndex)}`,
        title: candidate.title,
        steps,
        category: candidate.category ?? "Core product",
        whyItMatters: candidate.whyItMatters ?? null,
        preconditions: candidate.preconditions ?? [],
        checkpoints: (candidate.checkpoints ?? [steps]).map(journeyCheckpointGoal),
        role: candidate.role ?? "journey",
        ownerConfirmation: candidate.ownerConfirmation ?? "not_needed",
        sequence: proposalIndex * 1_000 + caseIndex,
      }];
    })
  ));
  // While the agent is walking (a first round OR a woken one), its live
  // journey events are the freshest truth — a woken round edits the list the
  // stale result still holds, and showing that result would hide the edits.
  // Settled, the persisted proposal is authoritative again.
  const walking = activity.status === "running" || activity.status === "queued";
  const live = walking ? liveCandidateCases(activity) : [];
  if (live.length) return live;
  return persisted.length ? persisted : liveCandidateCases(activity);
}
