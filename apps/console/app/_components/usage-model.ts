/**
 * What the Usage pane draws, worked out from the team's allowance and its Runs
 * per day: the month's meter, and the year of days laid out like GitHub's
 * contribution graph. Everything counts in UTC, as the quota does.
 */

const DAY_MS = 86_400_000;
const WEEKDAY = { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" } as const;
const dayFormat = new Intl.DateTimeFormat("en-US", WEEKDAY);
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const monthNameFormat = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const resetFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** The month's Runs against the quota (null is no limit). */
interface RunAllowance {
  used: number;
  quota: number | null;
}

/** Run now is off once the team has used the month's Runs. */
export function runsExhausted(allowance: RunAllowance | undefined): allowance is RunAllowance & { quota: number } {
  return allowance !== undefined && allowance.quota !== null && allowance.used >= allowance.quota;
}

/** `1 Run`, `2 Runs`. */
export function runCount(count: number): string {
  return `${String(count)} ${count === 1 ? "Run" : "Runs"}`;
}

/** The month the Runs are counted in, `October`. */
export function monthName(now: Date): string {
  return monthNameFormat.format(now);
}

/** When the month's Runs start again: the first of next month, `Nov 1`. */
export function resetDay(now: Date): string {
  return resetFormat.format(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
}

type MeterState = "ok" | "near" | "spent";

/** Amber from four fifths of the quota, red once it is used. */
export function meterState(used: number, quota: number): MeterState {
  if (used >= quota) return "spent";
  return used >= quota * 0.8 ? "near" : "ok";
}

interface RunDayRow {
  day: string;
  projectId: string;
  runs: number;
}

export interface HeatCell {
  date: string;
  week: number;
  weekday: number;
  /** 0 for no Runs, then 1–4 by share of the busiest day. */
  level: number;
  tip: string;
  today: boolean;
}

export interface HeatGrid {
  cells: HeatCell[];
  /** A month's label sits over the week its first day falls in. */
  months: { week: number; label: string }[];
  total: number;
}

/** The last of the 53 week columns, which carries no month label. */
const LAST_WEEK = 52;

function levelOf(runs: number, max: number): number {
  return runs === 0 ? 0 : Math.ceil((4 * runs) / max);
}

function tipOf(runs: number, dayMs: number): string {
  return `${runs ? runCount(runs) : "No Runs"} · ${dayFormat.format(new Date(dayMs))}`;
}

/** The first column names the month already under way when the grid starts, unless a month begins in it. */
function monthLabels(startMs: number, firsts: { week: number; label: string }[]) {
  return firsts[0]?.week === 0 ? firsts : [{ week: 0, label: monthFormat.format(new Date(startMs)) }, ...firsts];
}

/**
 * The year of days for `projectId` (null for every project): a column per
 * week with Sunday on top, from the Sunday of the week 364 days before today
 * through today; days after today are not drawn. Levels scale to the busiest
 * day shown, as GitHub's do.
 */
export function heatGrid(rows: readonly RunDayRow[], projectId: string | null, now: Date): HeatGrid {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const firstMs = todayMs - 364 * DAY_MS;
  const startMs = firstMs - new Date(firstMs).getUTCDay() * DAY_MS;
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (projectId === null || row.projectId === projectId) counts.set(row.day, (counts.get(row.day) ?? 0) + row.runs);
  }
  const days: { ms: number; date: string; runs: number }[] = [];
  for (let ms = startMs; ms <= todayMs; ms += DAY_MS) {
    const date = new Date(ms).toISOString().slice(0, 10);
    days.push({ ms, date, runs: counts.get(date) ?? 0 });
  }
  const max = Math.max(0, ...days.map((day) => day.runs));
  const cells = days.map(({ ms, date, runs }, index): HeatCell => ({
    date,
    week: Math.floor(index / 7),
    weekday: index % 7,
    level: levelOf(runs, max),
    tip: tipOf(runs, ms),
    today: ms === todayMs,
  }));
  const firsts = cells
    .filter((cell) => cell.date.endsWith("-01") && cell.week < LAST_WEEK)
    .map((cell) => ({ week: cell.week, label: monthFormat.format(new Date(`${cell.date}T00:00:00Z`)) }));
  return { cells, months: monthLabels(startMs, firsts), total: days.reduce((sum, day) => sum + day.runs, 0) };
}
