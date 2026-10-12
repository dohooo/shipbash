"use client";

import type { Schedule } from "../../lib/web-client";

/** Every IANA zone, with the one the browser detected pinned first as "(current)". */
export function TimezoneSelect({ id, value, disabled, onChange }: {
  id: string;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const current = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const rest = zones.filter((zone) => zone !== current);
  if (value && value !== current && !rest.includes(value)) rest.unshift(value);
  return (
    <select disabled={disabled} id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value={current}>{current} (current)</option>
      {rest.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
    </select>
  );
}

type Cadence = Schedule["cadence"];

/** The three cadences every schedule form offers, and the only values one can report. */
const CADENCES: readonly Cadence[] = ["off", "daily", "cron"];

export function isCadence(value: string): value is Cadence {
  return CADENCES.some((cadence) => cadence === value);
}
