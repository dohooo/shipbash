"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { CaseChecklistItem } from "@shipbash/contracts/execution-types";
import type { RunCaseView } from "@shipbash/contracts/api/view-types";
import { type CaseResult, readQuery } from "../../lib/web-client";
import { evidenceConsoleUrl, evidenceSteps, type EvidenceStep } from "../_lib/evidence";
import { safeHref } from "../_lib/navigation";
import { handoffVerdict, type HandoffVerdict } from "../_lib/repro-prompt";
import { runPollInterval } from "../_lib/run-report";
import {
  ConsoleFold,
  HistoryBreak,
  HistoryControls,
  HistoryMedia,
  HistoryRow,
  HistoryShots,
  WalkHandoff,
  type BrokenCheckpoint,
  type CaseDetail,
} from "./journey-run-card-parts";
import { resultMark, SectionLoading } from "./shell";

/** "failed." / "passed." — what the row says before its evidence is loaded. */
function verdictNote(verdict: string | null): string {
  if (verdict === "passed") return "passed.";
  if (verdict === "failed" || verdict === "error") return "failed.";
  if (verdict === "blocked") return "blocked before it could be judged.";
  if (verdict === "exempted") return "failed once, passed on an immediate re-run. Counted as flaky, not as a failure.";
  if (verdict === "canceled") return "stopped before a verdict was reached.";
  if (verdict === "not_run") return "was not walked — the run stopped before reaching it.";
  return "has not reported a verdict.";
}

/** The checkpoint the walk died on, once the run's detail has arrived. */
function brokenCheckpoint(checklist: readonly CaseChecklistItem[]): BrokenCheckpoint | null {
  const index = checklist.findIndex((item) => item.status === "failed");
  const failed = checklist[index];
  if (!failed) return null;
  return {
    position: `Broke at step ${String(index + 1)} of ${String(checklist.length)}`,
    goal: failed.goal,
    reason: failed.reason,
  };
}

interface WalkEvidence {
  runQuery: ReturnType<typeof useWalkEvidence>["runQuery"];
  suiteCase: RunCaseView | null;
  detail: CaseDetail | null;
  broken: BrokenCheckpoint | null;
  steps: EvidenceStep[];
  consoleUrl: string | null;
  screenshotUrl: string | null;
}

/**
 * Everything the open fold reads, in one place: the walk's run, files
 * included. The read is gated on the fold, so a seven-run history costs
 * nothing until a run is opened.
 */
function useWalkEvidence(projectId: string, result: CaseResult, open: boolean) {
  const runQuery = useQuery({
    ...readQuery("verification", projectId, result.runId),
    enabled: open,
    // Read as every run is: "Still being saved…" resolves itself into the
    // player, and a walk still going moves on.
    refetchInterval: (state) => runPollInterval(state.state.data?.view, false),
  });
  const suiteCase: RunCaseView | null = runQuery.data?.view.cases
    .find((entry) => entry.id === result.caseRunId) ?? null;
  const detail = suiteCase?.detail ?? null;
  return {
    runQuery,
    suiteCase,
    detail,
    broken: suiteCase ? brokenCheckpoint(suiteCase.detail.checklist) : null,
    steps: detail ? evidenceSteps(detail.artifacts) : [],
    consoleUrl: detail ? evidenceConsoleUrl(detail.artifacts) : null,
    screenshotUrl: detail?.screenshotUrl && safeHref(detail.screenshotUrl) !== "#"
      ? safeHref(detail.screenshotUrl)
      : null,
  };
}

/**
 * The walk's evidence — where it broke, the frame at that moment, the
 * recording, every step screenshot and the page's console — and its hand-off.
 */
function WalkEvidenceBody({ evidence, failed, handoff, journeyTitle, caseRunId, runHref, shotsOpen, onToggleShots }: {
  evidence: WalkEvidence;
  failed: boolean;
  /** What this walk hands over once settled; null while it has no verdict to hand. */
  handoff: HandoffVerdict | null;
  journeyTitle: string;
  caseRunId: string;
  runHref: string;
  shotsOpen: boolean;
  onToggleShots: () => void;
}) {
  const { runQuery, suiteCase, detail, broken, steps, consoleUrl, screenshotUrl } = evidence;
  return (
    <div className="history-body">
      {runQuery.isPending ? <SectionLoading /> : null}
      {/* A failed poll leaves the evidence on screen; only a first read that failed says so. */}
      {runQuery.isLoadingError ? (
        <p className="history-empty">This walk&apos;s evidence could not be loaded.</p>
      ) : null}
      {detail?.summary ? <p className="history-summary">{detail.summary}</p> : null}

      {failed && suiteCase ? (
        <HistoryBreak
          broken={broken}
          detail={detail}
          screenshotUrl={screenshotUrl}
        />
      ) : null}

      {/* Every settled walk hands over, whether or not its run's detail has loaded. */}
      {handoff ? <WalkHandoff caseRunId={caseRunId} journeyTitle={journeyTitle} verdict={handoff} /> : null}

      <HistoryMedia
        detail={detail}
        failed={failed}
        journeyTitle={journeyTitle}
        screenshotUrl={screenshotUrl}
      />

      <HistoryControls
        onToggleShots={onToggleShots}
        runHref={runHref}
        shotsOpen={shotsOpen}
        steps={steps}
      />

      {shotsOpen && steps.length ? <HistoryShots steps={steps} /> : null}

      {consoleUrl ? <ConsoleFold url={consoleUrl} /> : null}
    </div>
  );
}

/**
 * One walk of this journey, opened in place. The row is the verdict; the body
 * is its evidence, which is fetched only once the walk is opened.
 */
export function JourneyRunCard({
  result,
  journeyTitle,
  projectId,
  runHref,
  trigger,
  defaultOpen,
}: {
  result: CaseResult;
  journeyTitle: string;
  projectId: string;
  runHref: string;
  trigger: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [shotsOpen, setShotsOpen] = useState(false);
  const evidence = useWalkEvidence(projectId, result, open);
  const mark = resultMark(result.verdict);
  const failed = mark === "failed";
  const note = failed && evidence.broken
    ? `${evidence.broken.position.toLowerCase()} · ${evidence.broken.goal}`
    : verdictNote(result.verdict);

  return (
    <article className="history-card" data-failed={failed ? "true" : undefined}>
      <HistoryRow
        mark={mark}
        note={note}
        onToggle={() => setOpen((current) => !current)}
        open={open}
        result={result}
        trigger={trigger}
      />
      {open ? (
        <WalkEvidenceBody
          evidence={evidence}
          failed={failed}
          handoff={handoffVerdict(result.verdict)}
          caseRunId={result.caseRunId}
          journeyTitle={journeyTitle}
          onToggleShots={() => setShotsOpen((current) => !current)}
          runHref={runHref}
          shotsOpen={shotsOpen}
        />
      ) : null}
    </article>
  );
}
