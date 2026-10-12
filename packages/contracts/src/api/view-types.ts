/** API view types are inferred from the same schemas that validate the wire. */
import type { z } from "zod";

import type { CaseVerdict } from "../database-contract-types.ts";
import type {
	activityEventViewSchema,
	activityReviewSchema,
	activityViewSchema,
} from "./activities.ts";
import type {
	journeyDetailSchema,
	runViewSchema,
	scheduleSchema,
} from "./journeys.ts";
import type { projectViewSchema } from "./projects.ts";
import type { proposalViewSchema } from "./proposals.ts";
import type {
	browserRecordingViewSchema,
	liveRunViewSchema,
	runEventViewSchema,
} from "./runs.ts";
import type {
	boundSignInViewSchema,
	projectSignInBindingSchema,
	teamSignInViewSchema,
} from "./sign-ins.ts";
import type { trustedAccessViewSchema } from "./trusted-access.ts";

export type ScheduleView = z.output<typeof scheduleSchema>;
export type SuiteDetailView = z.output<typeof journeyDetailSchema>;
export type ActivityView = z.output<typeof activityViewSchema>;
export type ActivityEventView = z.output<typeof activityEventViewSchema>;
export type ActivityReviewView = z.output<typeof activityReviewSchema>;
export type ProjectView = z.output<typeof projectViewSchema>;
export type ProjectTrustedAccessView = z.output<typeof trustedAccessViewSchema>;
export type TeamSignInView = z.output<typeof teamSignInViewSchema>;
export type BoundSignInView = z.output<typeof boundSignInViewSchema>;
export type ProjectSignInBindingView = z.output<
	typeof projectSignInBindingSchema
>;
export type ProposalView = z.output<typeof proposalViewSchema>;
export type RunView = z.output<typeof runViewSchema>;
export type BrowserRecordingViewModel = z.output<typeof browserRecordingViewSchema>;
export type LiveRunViewModel = z.output<typeof liveRunViewSchema>;
/** A line of a run's execution log. */
export type RunEventView = z.output<typeof runEventViewSchema>;
/** One row of the run page: a Case, the walk on show, and its other walks. */
export type RunCaseView = LiveRunViewModel["cases"][number];
export type CaseAttemptView = RunCaseView["attempts"][number];
/**
 * Executor-resolved pointer target in CSS viewport coordinates of the tested
 * page. Drives the Agent cursor overlay; never fabricated when unavailable.
 */
export type RunEventPointer = NonNullable<RunEventView["pointer"]>;
/**
 * The run as the run page renders it, the operator's view and a shared one
 * alike: neither whether it is shared nor what started it, and a verdict
 * read in the Case vocabulary.
 */
export type RunPageView = Omit<
	LiveRunViewModel,
	"isPublic" | "triggerKind" | "verdict" | "result"
> & {
	verdict: CaseVerdict | null;
	result:
		| (Omit<NonNullable<LiveRunViewModel["result"]>, "verdict"> & {
				verdict: CaseVerdict;
		  })
		| null;
};
