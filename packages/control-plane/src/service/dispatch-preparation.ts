/**
 * Dispatch preparation, suite side: what must be true before a Runner
 * container may execute a verification.
 *
 * Both halves live in ./dispatch-preparation/: the recovery path that
 * salvages results an interrupted prior execution already produced, and the
 * preparation path that assembles the run-scoped auth snapshot.
 * DispatchWorkerOptions is the seam these hooks plug into.
 */
import type { JobApiResources } from "../job-api/define.ts";
import type { DispatchWorkerOptions } from "../dispatch-worker-types.ts";
import { createPrepareSuite } from "./dispatch-preparation/suite-prepare.ts";
import { createRecoverSuite } from "./dispatch-preparation/suite-recovery.ts";
import type { TaskAuthPlumbing } from "./task-auth-plumbing.ts";

/** What suite preparation borrows from the service closure. */
export interface SuitePreparationContext {
  /** The store and what the run's job port serves from: its opening, its evidence, the token its agents read GitHub on, and the task API the runner asks. */
  jobApi: JobApiResources;
  runtimeTemporaryDirectory: string | undefined;
  taskAuth: TaskAuthPlumbing;
  trackProjectHash(projectId: string): string;
}

export interface SuitePreparation {
  recoverSuite: NonNullable<DispatchWorkerOptions["recoverSuite"]>;
  prepareSuite: DispatchWorkerOptions["prepareSuite"];
}

export function createSuitePreparation(context: SuitePreparationContext): SuitePreparation {
  return {
    recoverSuite: createRecoverSuite(context),
    prepareSuite: createPrepareSuite(context),
  };
}
