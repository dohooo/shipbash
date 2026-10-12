"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CronExpressionParser } from "cron-parser";
import { toast } from "sonner";

import { readQuery, type Schedule, type SuiteDetail, webClient } from "../../lib/web-client";
import { apiMessage } from "../_lib/request-errors";
import { isCadence, TimezoneSelect } from "./journey-schedule";
import { RelativeTime } from "./relative-time";

export type ScheduleDraft = Pick<Schedule, "cadence" | "localTime" | "cronExpression" | "timezone">;

/**
 * The next few times this draft would fire, in the viewer's clock — the
 * preview IS the validation, so a typo is visible before it is saved.
 */
function cronPreview(draft: ScheduleDraft): string[] | null {
  if (draft.cadence !== "cron" || !draft.cronExpression?.trim() || !draft.timezone?.trim()) return null;
  try {
    const interval = CronExpressionParser.parse(draft.cronExpression.trim(), {
      strict: false,
      tz: draft.timezone.trim(),
    });
    return [interval.next(), interval.next(), interval.next()].map((occurrence) =>
      occurrence.toDate().toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  } catch {
    return null;
  }
}

/** What the form opens on: the reader's unsaved draft, or the saved schedule. */
function scheduleValue(current: Schedule | null, draft: ScheduleDraft | null): ScheduleDraft {
  return draft ?? {
    cadence: current?.cadence ?? "off",
    localTime: current?.localTime ?? "02:00",
    cronExpression: current?.cronExpression ?? "0 9 * * 1-5",
    timezone: current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** The fields each cadence brings with it, and the zone the last two share. */
function CadenceFields({ value, readOnly, onChange }: {
  value: ScheduleDraft;
  readOnly: boolean;
  onChange: (next: ScheduleDraft) => void;
}) {
  return (
    <div className="settings-grid">
      <label className="form-field">
        <span>Cadence</span>
        <select
          disabled={readOnly}
          value={value.cadence}
          onChange={(event) => { if (isCadence(event.target.value)) onChange({ ...value, cadence: event.target.value }); }}
        >
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="cron">Custom (cron)</option>
        </select>
      </label>
      {value.cadence === "daily" ? (
        <label className="form-field">
          <span>Run daily at</span>
          <input
            type="time"
            disabled={readOnly}
            required
            value={value.localTime ?? "02:00"}
            onChange={(event) => onChange({ ...value, localTime: event.target.value })}
          />
        </label>
      ) : null}
      {value.cadence === "cron" ? (
        <label className="form-field">
          <span>Cron expression</span>
          <input
            disabled={readOnly}
            required
            placeholder="0 9 * * 1-5"
            value={value.cronExpression ?? ""}
            onChange={(event) => onChange({ ...value, cronExpression: event.target.value })}
          />
        </label>
      ) : null}
      {value.cadence !== "off" ? (
        <label className="form-field" htmlFor="settings-schedule-timezone">
          <span>Time zone</span>
          <TimezoneSelect
            disabled={readOnly} id="settings-schedule-timezone"
            value={value.timezone ?? ""}
            onChange={(timezone) => onChange({ ...value, timezone })}
          />
        </label>
      ) : null}
    </div>
  );
}

/** Either the next few fires, or the reason there are none to show. */
function CronNote({ value, preview }: { value: ScheduleDraft; preview: string[] | null }) {
  return value.cadence === "cron" ? (
    preview ? (
      <p className="settings-note">Next: {preview.join(" · ")}</p>
    ) : value.cronExpression?.trim() ? (
      <p className="inline-error" role="alert">Not a valid cron expression for this time zone.</p>
    ) : null
  ) : null;
}

/** The saved schedule for one suite, and the draft that would replace it. */
export function ScheduleForm({ projectId, suite, draft, readOnly, onDraftChange }: {
  projectId: string;
  suite: SuiteDetail;
  draft: ScheduleDraft | null;
  readOnly: boolean;
  onDraftChange: (next: ScheduleDraft | null) => void;
}) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (value: ScheduleDraft) => webClient.updateSchedule(projectId, suite.id, value),
    // The saved schedule goes where the form reads it before the draft goes,
    // so the form never falls back to the schedule it replaced.
    onSuccess: ({ schedule }) => {
      queryClient.setQueryData(readQuery("journeys", projectId).queryKey, (journeys) => journeys && {
        ...journeys,
        suites: journeys.suites.map((entry) => (entry.id === suite.id ? { ...entry, schedule } : entry)),
      });
      onDraftChange(null);
      toast.success("Schedule saved");
    },
  });
  const current = suite.schedule;
  const value = scheduleValue(current, draft);
  const preview = cronPreview(value);
  return (
    <form onSubmit={(event) => { event.preventDefault(); save.mutate(value); }}>
      <CadenceFields value={value} readOnly={readOnly} onChange={onDraftChange} />
      <CronNote value={value} preview={preview} />
      {current?.nextRunAt && current.cadence !== "off" ? (
        <p className="settings-note">Next run <RelativeTime value={current.nextRunAt} /></p>
      ) : null}
      {save.isError ? <p className="inline-error" role="alert">{apiMessage(save.error, "ShipBash could not save this change.")}</p> : null}
      {readOnly ? null : (
        <button
          className="button primary"
          type="submit"
          disabled={save.isPending || !draft || (value.cadence === "cron" && !preview)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      )}
    </form>
  );
}
