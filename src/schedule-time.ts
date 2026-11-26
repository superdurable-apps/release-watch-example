/** When the digest runs: a local time in an IANA time zone, on weekdays or every day. */
export interface DigestSchedule {
  /** IANA time zone, such as America/Los_Angeles. */
  readonly timeZone: string;
  /** Local time HH:MM, 24-hour. */
  readonly localTime: string;
  /** True to skip Saturday and Sunday; Monday's digest then covers the weekend. */
  readonly weekdaysOnly: boolean;
}

export const DEFAULT_SCHEDULE: DigestSchedule = { timeZone: "America/Los_Angeles", localTime: "08:00", weekdaysOnly: true };

/** Throws a message a person can act on when the schedule cannot be used. */
export function validateSchedule(schedule: DigestSchedule): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime)) {
    throw new RangeError("localTime must be HH:MM, 24-hour");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone });
  } catch {
    throw new RangeError(`timeZone ${schedule.timeZone} is not an IANA time zone`);
  }
}

/** The next run strictly after now, and its local calendar date (YYYY-MM-DD). */
export function nextOccurrence(now: Date, schedule: DigestSchedule): { readonly at: Date; readonly localDate: string } {
  const [hour, minute] = schedule.localTime.split(":").map(Number) as [number, number];
  const today = localParts(now, schedule.timeZone);
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = day.getUTCDay();
    if (schedule.weekdaysOnly && (weekday === 0 || weekday === 6)) {
      continue;
    }
    const at = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, schedule.timeZone);
    if (at.getTime() > now.getTime()) {
      return { at, localDate: isoDate(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()) };
    }
  }
  throw new Error("no occurrence within a week");
}

/** The local calendar date of an instant, YYYY-MM-DD. */
export function localDate(now: Date, timeZone: string): string {
  const parts = localParts(now, timeZone);
  return isoDate(parts.year, parts.month, parts.day);
}

function localParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(formatted.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
}

/** The instant of a local wall-clock time in a time zone, correct across daylight-saving changes. */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess;
  for (let round = 0; round < 3; round++) {
    const parts = localParts(new Date(instant), timeZone);
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    instant += guess - shown;
  }
  return new Date(instant);
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
