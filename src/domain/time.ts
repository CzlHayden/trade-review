// The single home for calendar boundaries. Weeks and hold-time buckets use the MACHINE-LOCAL
// timezone (declared once here — Plan 6 decision 7) so weekly-journal date association is
// deterministic for a given install. Weeks are ISO-8601 (Monday start, week 1 contains Jan 4).

const DAY_MS = 86_400_000;

/** Mon=0 … Sun=6 for a local Date. */
function isoDayNum(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/** Thursday (00:00 local) of the ISO week containing `d`'s date. Thursday fixes the ISO year. */
function thursdayOfWeek(d: Date): Date {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() - isoDayNum(t) + 3);
  return t;
}

/** ISO week key ("YYYY-Www") for an epoch-ms instant, in machine-local time. */
export function isoWeekOf(ms: number): string {
  const thu = thursdayOfWeek(new Date(ms));
  const isoYear = thu.getFullYear();
  const firstThu = thursdayOfWeek(new Date(isoYear, 0, 4)); // Thursday of ISO week 1
  const week = 1 + Math.round((thu.getTime() - firstThu.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** [start, end) epoch-ms for an ISO week key. `end - start` is exactly 7 days. */
export function weekRange(isoWeek: string): { start: number; end: number } {
  const [yStr, wStr] = isoWeek.split("-W");
  const isoYear = Number(yStr);
  const week = Number(wStr);
  const jan4 = new Date(isoYear, 0, 4);
  const week1Monday = new Date(isoYear, 0, 4 - isoDayNum(jan4)); // local midnight Monday of week 1
  const start = week1Monday.getTime() + (week - 1) * 7 * DAY_MS;
  return { start, end: start + 7 * DAY_MS };
}

/** Hold-time bucket for the "by hold-time" breakdown. `null` seconds = still-open trade. */
export function holdBucket(holdSeconds: number | null): string {
  if (holdSeconds === null) return "open";
  const days = holdSeconds / 86_400;
  if (days < 1) return "intraday";
  if (days < 2) return "1d";
  if (days < 6) return "2-5d";
  if (days < 15) return "1-2w";
  return "2w+";
}
