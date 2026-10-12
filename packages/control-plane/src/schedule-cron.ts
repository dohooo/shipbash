/**
 * Occurrence math for Schedules: the cron expressions, timezones, and
 * next-firing projections shared by the queue, the store, and the API.
 */
import { CronExpressionParser, type CronExpression } from "cron-parser";

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function dailyCron(localTime: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new Error("Daily time must use HH:mm.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Daily time must be a valid 24-hour time.");
  return `${minute} ${hour} * * *`;
}

export function assertIanaTimezone(value: string): string {
  const timezone = nonEmpty(value, "timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("timezone must be a valid IANA timezone.");
  }
  return timezone;
}

/**
 * Uses the same cron parser and timezone semantics as pg-boss so the persisted
 * projection cannot disagree with the occurrence the queue will actually emit.
 */
export function nextDailyOccurrence(
  localTime: string,
  timezone: string,
  after: Date = new Date(),
): string {
  return nextCronOccurrence(dailyCron(localTime.slice(0, 5)), timezone, after);
}

export function nextCronOccurrence(
  expression: string,
  timezone: string,
  after: Date = new Date(),
): string {
  if (Number.isNaN(after.valueOf())) throw new Error("after must be a valid Date.");
  const interval = CronExpressionParser.parse(expression, {
    currentDate: after,
    strict: false,
    tz: assertIanaTimezone(timezone),
  });
  return interval.next().toDate().toISOString();
}

/** Every occurrence is a real agent run; a slip of the hand must not buy 288 of them a day. */
const MIN_CRON_INTERVAL_MS = 10 * 60 * 1_000;

export function assertCronExpression(expression: string, timezone: string): string {
  const normalized = nonEmpty(expression, "cronExpression");
  const tz = assertIanaTimezone(timezone);
  if (normalized.split(/\s+/u).length !== 5) {
    throw new Error("Cron expression must have five fields: minute hour day month weekday.");
  }
  let interval: CronExpression;
  try {
    interval = CronExpressionParser.parse(normalized, { strict: false, tz });
  } catch {
    throw new Error("Cron expression is not valid.");
  }
  // Sampling consecutive occurrences catches the dense expressions a static
  // look at the fields cannot, e.g. minute lists that fire twice an hour.
  let previous = interval.next().toDate().valueOf();
  for (let index = 0; index < 8; index += 1) {
    const next = interval.next().toDate().valueOf();
    if (next - previous < MIN_CRON_INTERVAL_MS) {
      throw new Error("Cron Schedules may fire at most every 10 minutes.");
    }
    previous = next;
  }
  return normalized;
}

/** The one expression a Schedule ticks on, whichever way it was written. */
export function scheduleCronExpression(schedule: {
  cadence: string;
  localTime: string | null;
  cronExpression?: string | null | undefined;
}): string | null {
  if (schedule.cadence === "daily" && schedule.localTime) {
    return dailyCron(schedule.localTime.slice(0, 5));
  }
  if (schedule.cadence === "cron" && schedule.cronExpression) return schedule.cronExpression;
  return null;
}
