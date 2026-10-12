"use client";

/**
 * Team → Usage: the month's Runs against the team's quota, and a year of
 * Runs by day. The quota is the team's, so the pane is drawn with or without
 * a product; Journeys only turns Run now off once the month's Runs are used.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { readQuery } from "../../lib/web-client";
import { useWorkspace } from "./shell";
import { type HeatGrid, heatGrid, meterState, resetDay, runCount } from "./usage-model";
import { teamProjects } from "./workspace-address";

const WEEKDAY_LABELS = [{ row: 3, label: "Mon" }, { row: 5, label: "Wed" }, { row: 7, label: "Fri" }] as const;
const LEGEND = [0, 1, 2, 3, 4] as const;
/** The least room between two month labels before the later one is hidden. */
const MONTH_GAP_PX = 8;

/**
 * The grid narrows with its card rather than scrolling, so month labels thin
 * themselves out: one that would come within MONTH_GAP_PX of the last one
 * shown is hidden, measured again whenever the grid's width changes.
 */
function useThinMonthLabels() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    const labels = [...grid.querySelectorAll<HTMLElement>(".heat-month")];
    const thin = () => {
      let edge = Number.NEGATIVE_INFINITY;
      for (const label of labels) label.hidden = false;
      for (const label of labels) {
        const box = label.getBoundingClientRect();
        if (box.left < edge + MONTH_GAP_PX) label.hidden = true;
        else edge = box.right;
      }
    };
    const observer = new ResizeObserver(thin);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function MonthlyRuns({ teamId }: { teamId: string }) {
  const { data } = useSuspenseQuery(readQuery("runAllowance", teamId));
  const { used, quota } = data;
  const reset = resetDay(new Date());
  return (
    <section className="settings-card" aria-labelledby="usage-title">
      <div className="settings-card-head">
        <div>
          <h2 id="usage-title">Monthly Runs</h2>
          <p>Resets {reset} · counted in UTC</p>
        </div>
      </div>
      {quota === null ? (
        <div className="usage-meter">
          <div className="usage-meter-top"><b>{used}</b><span>{used === 1 ? "Run" : "Runs"} this month</span></div>
        </div>
      ) : (
        <div className="usage-meter" data-state={meterState(used, quota)}>
          <div className="usage-meter-top">
            <b>{used}</b>
            <span>of {quota} used</span>
            <em>{Math.max(quota - used, 0)} left</em>
          </div>
          <span className="usage-bar" role="img" aria-label={`${String(used)} of ${runCount(quota)} used`}>
            <i style={{ width: `${String(quota === 0 ? 100 : Math.min(100, (used / quota) * 100))}%` }} />
          </span>
          <p className="usage-meter-note">
            {used >= quota ? `Run now is off until ${reset}.` : `Run now turns off at ${String(quota)} and comes back on ${reset}.`}
          </p>
        </div>
      )}
    </section>
  );
}

function Heatmap({ grid, label }: { grid: HeatGrid; label: string }) {
  const ref = useThinMonthLabels();
  return (
    <div className="heat-grid" ref={ref} role="img" aria-label={label}>
      {grid.months.map((month) => (
        <span className="heat-month" key={month.week} style={{ gridColumn: month.week + 2, gridRow: 1 }}>{month.label}</span>
      ))}
      {WEEKDAY_LABELS.map((day) => (
        <span className="heat-day" key={day.label} style={{ gridColumn: 1, gridRow: day.row }}>{day.label}</span>
      ))}
      {grid.cells.map((cell) => (
        <i
          className="heat-cell"
          data-level={cell.level}
          data-tip={cell.tip}
          data-today={cell.today || undefined}
          key={cell.date}
          style={{ gridColumn: cell.week + 2, gridRow: cell.weekday + 2 }}
        />
      ))}
    </div>
  );
}

function YearOfRuns({ teamId }: { teamId: string }) {
  const { session } = useWorkspace();
  const { data } = useSuspenseQuery(readQuery("runDays", teamId));
  const [projectId, setProjectId] = useState<string | null>(null);
  const projects = teamProjects(session, teamId);
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  const grid = heatGrid(data.days, project?.id ?? null, new Date());
  const total = runCount(grid.total);
  return (
    <section className="settings-card" aria-labelledby="heat-title">
      <div className="settings-card-head">
        <div>
          <h2 id="heat-title">{total} in the last year</h2>
          <p>Each square is a day.</p>
        </div>
        <label className="form-field usage-filter">
          <span className="sr-only">Project</span>
          <select aria-label="Filter by project" onChange={(event) => setProjectId(event.target.value || null)} value={project?.id ?? ""}>
            <option value="">All projects</option>
            {projects.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
      </div>
      <div className="heat">
        <Heatmap grid={grid} label={`${total} in the last year, by day${project ? ` in ${project.name}` : ""}`} />
        <div className="heat-foot">
          <span>Counted in UTC</span>
          <div className="heat-legend" aria-hidden="true">
            <span>Less</span>
            {LEGEND.map((level) => <i data-level={level} key={level} />)}
            <span>More</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export function UsagePane() {
  const { team } = useWorkspace();
  return (
    <>
      <MonthlyRuns teamId={team.id} />
      <YearOfRuns teamId={team.id} />
    </>
  );
}
