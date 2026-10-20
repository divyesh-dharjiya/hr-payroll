// Timezone-aware date helpers.
//
// Storage rule: instants are stored as UTC timestamps. Calendar days (attendance, leave, holidays) are stored as
// DATE values and interpreted in the organization's configured timezone when "today" is derived.

const DAY_MS = 86_400_000;

/** Returns the calendar date (YYYY-MM-DD) of an instant as seen in the given IANA timezone. */
export function calendarDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    instant,
  );
}

/** The organization's current calendar date (YYYY-MM-DD). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return calendarDate(now, timeZone);
}

/** Offset (in minutes, east positive) of a timezone at a given instant. */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((asUtc - truncated) / 60_000);
}

/** Converts a local wall-clock time on a calendar date in a timezone to a UTC instant. */
export function zonedTimeToUtc(dateYmd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMinutes(new Date(guess), timeZone);
  let instant = guess - offset * 60_000;
  // Correct for DST transitions where the first guess used the wrong offset.
  const offset2 = tzOffsetMinutes(new Date(instant), timeZone);
  if (offset2 !== offset) instant = guess - offset2 * 60_000;
  return new Date(instant);
}

/** A DATE column value (UTC midnight) for a YYYY-MM-DD string. */
export function dateOnly(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** YYYY-MM-DD from a DATE column value (which is stored at UTC midnight). */
export function ymdOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings between two dates. */
export function eachDay(startYmd: string, endYmd: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${startYmd}T00:00:00Z`); t <= Date.parse(`${endYmd}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Day of week (0 = Sunday) of a YYYY-MM-DD string. Calendar arithmetic, timezone independent. */
export function weekdayOf(ymd: string): number {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

/** Number of days in a month (month is 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthRange(year: number, month: number): { from: string; to: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = daysInMonth(year, month);
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}` };
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 60_000);
}
