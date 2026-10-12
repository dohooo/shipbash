"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  journeyScriptBlocks,
  type JourneyCheckpoint,
  type JourneyStep,
  type RunSummary,
} from "../../lib/web-client";
import { caseSlotLabel } from "../_lib/case-slot";
import { caseResultDots, type ProjectJourney, type StagedCaseEdit } from "../_lib/journeys";
import { mutationMessage } from "../_lib/request-errors";
import { statusLabel } from "../_lib/status";
import { ActionButton } from "./action-button";
import { DraftPreconditions } from "./draft-review-parts";
import { JourneyHistory } from "./journey-history";
import { journeyMark } from "./journeys-page-model";
import { useArchiveJourney } from "./journeys-page-table";
import { RelativeTime } from "./relative-time";
import {
  Empty,
  Exception,
  ResultDots,
  useWorkspace,
} from "./shell";

/**
 * The journey's script as the reader meets it: numbered actions, each carrying
 * the Shoulds that must hold once it is done.
 */
function JourneyScript({ steps, checkpoints, noun }: {
  steps: readonly JourneyStep[];
  checkpoints: readonly JourneyCheckpoint[];
  noun: CaseNoun;
}) {
  const rows: { action: string | null; shoulds: string[] }[] = [];
  for (const block of journeyScriptBlocks(steps, checkpoints)) {
    const last = rows.at(-1);
    if (block.kind === "step") rows.push({ action: block.text, shoulds: [] });
    else if (last) last.shoulds.push(block.text);
    else rows.push({ action: null, shoulds: [block.text] });
  }
  if (!rows.length) return <Empty title={`This ${noun} has no script yet`} />;
  return (
    <ol className="script">
      {rows.map((row, index) => (
        <li key={`${String(index)}-${row.action ?? ""}`}>
          <span className="script-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <div>
            {row.action ? <p className="script-action">{row.action}</p> : null}
            {row.shoulds.map((should) => (
              <p className="script-should" key={should}>
                <span className="should-label">Should</span>{should}
              </p>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The page's subject as its copy names it: a hook never reads as a Journey. */
type CaseNoun = "journey" | "hook";

/**
 * Starting a run and opening the editor, both of which live in the topbar.
 * The latest walk of THIS journey anchors a single-journey re-run; before any
 * walk exists there is nothing to anchor, so the whole suite runs. A hook
 * runs only around Journeys, never on its own, so its page offers no run.
 */
export function JourneyRunActions({ hasWalk, pending, onRun, onEdit }: {
  hasWalk: boolean;
  pending: boolean;
  onRun: (() => void) | null;
  onEdit: () => void;
}) {
  return (
    <div className="page-actions">
      <button className="button" type="button" onClick={onEdit}>Edit</button>
      {onRun ? (
        <ActionButton
          className="button primary"
          disabled={pending}
          action={onRun}
        >
          <Play aria-hidden="true" /> {pending ? "Starting…" : hasWalk ? "Run this journey" : "Run now"}
        </ActionButton>
      ) : null}
    </div>
  );
}

/** What the journey is, what it protects, and how it last fared; a hook leads with its slot. */
export function JourneyHead({ journey }: { journey: ProjectJourney }) {
  const eyebrow = caseSlotLabel(journey.role) ?? journey.category;
  return (
    <header className="journey-head">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1>{journey.title}</h1>
      {journey.whyItMatters ? <p className="journey-why-lead">{journey.whyItMatters}</p> : null}
      <div className="journey-meta">
        <Exception mark={journeyMark(journey)} />
        <ResultDots
          label={`Recent results for ${journey.title}`}
          results={caseResultDots(journey)}
        />
        {journey.latestRunAt
          ? <span className="journey-verified">Last verified <RelativeTime value={journey.latestRunAt} /></span>
          : <span className="journey-verified">Not verified yet</span>}
      </div>
    </header>
  );
}

/**
 * The live script with the preconditions it assumes. A staged edit is marked
 * here but not shown: it goes live only once a verify run passes it.
 */
export function JourneyScriptSection({ journey, staged, noun }: {
  journey: ProjectJourney;
  staged: StagedCaseEdit | undefined;
  noun: CaseNoun;
}) {
  const { teamHref } = useWorkspace();
  return (
    <section aria-labelledby="journey-script-title">
      <header className="section-head">
        <h2 id="journey-script-title">Script{staged ? <span className="pend-chip">Edited</span> : null}</h2>
        <span>{journey.steps.length} {journey.steps.length === 1 ? "step" : "steps"}</span>
      </header>
      {staged ? (
        <p className="form-note">
          Staged — not live until a verify run passes. <Link href={teamHref("/journeys")}>Verify it on Journeys</Link>
        </p>
      ) : null}
      <JourneyScript steps={journey.steps} checkpoints={journey.checkpoints} noun={noun} />
      <DraftPreconditions lines={journey.preconditions} />
    </section>
  );
}

/**
 * History speaks about THIS journey: its own verdict and duration per run, not
 * the whole run's rollup.
 */
export function JourneyHistorySection({ journey, noun, projectId, suiteRuns }: {
  journey: ProjectJourney;
  noun: CaseNoun;
  projectId: string;
  suiteRuns: ReadonlyMap<string, RunSummary>;
}) {
  const { teamHref } = useWorkspace();
  const history = [...journey.recentResults ?? []].reverse();
  return (
    <section className="section" aria-labelledby="journey-history-title">
      <header className="section-head">
        <h2 id="journey-history-title">History</h2>
        {history.length ? <span>{history.length} {history.length === 1 ? "run" : "runs"}</span> : null}
      </header>
      {history.length ? (
        <JourneyHistory
          journeyTitle={journey.title}
          projectId={projectId}
          runs={history.map((entry) => ({
            result: entry,
            runHref: `${teamHref(`/verifications/${encodeURIComponent(entry.runId)}`)}?journey=${encodeURIComponent(entry.caseRunId)}`,
            trigger: statusLabel(suiteRuns.get(entry.runId)?.triggerKind ?? "manual"),
          }))}
        />
      ) : (
        <Empty title="No runs yet" body={`This ${noun} has not been walked since it joined the schedule.`} />
      )}
    </section>
  );
}

/** Leaving the schedule, confirmed in place; any member of the project may. */
export function JourneyRemoveSection({ journey, noun }: {
  journey: Pick<ProjectJourney, "id" | "role" | "suiteId" | "suiteRevision">;
  noun: CaseNoun;
}) {
  const router = useRouter();
  const { teamHref } = useWorkspace();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const archive = useArchiveJourney(journey, () => router.push(teamHref("/journeys")));
  return (
    <section className="section journey-remove" aria-labelledby="journey-remove-title">
      <h2 id="journey-remove-title">{noun === "journey" ? "Stop guarding this journey" : "Remove this hook"}</h2>
      <p>It leaves the schedule immediately. Past runs and their evidence stay.</p>
      {confirmDelete ? (
        <div className="actions-row">
          <button className="button" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
          <button className="button danger" type="button" disabled={archive.isPending} onClick={() => archive.mutate()}>
            {archive.isPending ? "Removing…" : `Remove ${noun}`}
          </button>
        </div>
      ) : (
        <button className="button danger" type="button" onClick={() => setConfirmDelete(true)}>Remove {noun}</button>
      )}
      {archive.isError ? <p className="inline-error" role="alert">{mutationMessage(archive.error)}</p> : null}
    </section>
  );
}
