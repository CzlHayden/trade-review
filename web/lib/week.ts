// Client-side ISO week helpers — mirror the server's machine-local ISO-8601 weeks (Monday start,
// week 1 contains Jan 4). Same machine ⇒ same boundaries as the backend.

function isoDayNum(d: Date): number {
  return (d.getDay() + 6) % 7; // Mon=0 … Sun=6
}

export function isoWeekKey(d: Date): string {
  const thu = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  thu.setDate(thu.getDate() - isoDayNum(thu) + 3);
  const isoYear = thu.getFullYear();
  const firstThu = new Date(isoYear, 0, 4);
  firstThu.setDate(firstThu.getDate() - isoDayNum(firstThu) + 3);
  const week = 1 + Math.round((thu.getTime() - firstThu.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - isoDayNum(m));
  return m;
}

export function weekLabel(d: Date): string {
  const mon = mondayOf(d);
  return `Week of ${mon.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
