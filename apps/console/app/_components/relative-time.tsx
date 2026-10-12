"use client";

import { formatDistanceStrict } from "date-fns";
import { useEffect, useState } from "react";

interface RelativeTimeProps {
  value: string;
  className?: string;
}

/**
 * Under this, counting is worse than not counting. A test message that has
 * just landed reads "0 seconds ago", which says the row is stale in the one
 * moment it is freshest; every caller wants the same answer, so the floor
 * lives in the helper rather than in whichever surface noticed it.
 */
const JUST_NOW_MS = 10_000;

export function relativeTimeLabel(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  if (Math.abs(now.getTime() - date.getTime()) < JUST_NOW_MS) return "just now";
  return formatDistanceStrict(date, now, { addSuffix: true });
}

/**
 * How long ago something happened, which is only true at the moment someone
 * looks. Reading the clock while rendering would settle that moment during the
 * prerender and hand the same answer to everyone who arrived later, so the time
 * itself is what renders and the distance from now replaces it on arrival.
 */
export function RelativeTime({ value, className }: RelativeTimeProps) {
  const [relative, setRelative] = useState<string | null>(null);
  useEffect(() => setRelative(relativeTimeLabel(value, new Date())), [value]);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className={className}>Unknown time</span>;
  const exact = date.toLocaleString();
  return (
    <time
      className={className}
      dateTime={date.toISOString()}
      title={exact}
      suppressHydrationWarning
    >
      {relative ?? exact}
    </time>
  );
}
