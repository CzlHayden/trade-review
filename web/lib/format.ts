// Presentation formatters. Pure — unit-tested. NEVER combine values of different currencies here;
// callers pass already-per-currency numbers.

const CCY_SYMBOL: Record<string, string> = {
  USD: "$",
  HKD: "HK$",
  CNH: "¥",
  SGD: "S$",
  AUD: "A$",
  JPY: "¥",
  CAD: "C$",
  MYR: "RM",
};

/** Symbol for a currency, or the bare code (e.g. "USDT ") so crypto/unknown currencies stay labelled. */
function ccySym(currency: string): string {
  return CCY_SYMBOL[currency] ?? (currency ? `${currency} ` : "");
}

/** Signed money in a single currency, e.g. +$1,234.50 / −$88.99. Currency is shown, never converted. */
export function money(value: number, currency: string): string {
  const sym = ccySym(currency);
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${sym}${abs}`;
}

/** Unsigned money (prices, costs) — no leading + / −. */
export function price(value: number, currency = ""): string {
  const sym = ccySym(currency);
  return `${sym}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** R-multiple, e.g. +2.4R, −1.0R, or "—" when risk is unknown. */
export function rMultiple(r: number | null): string {
  if (r === null) return "—";
  const sign = r < 0 ? "−" : r > 0 ? "+" : "";
  return `${sign}${Math.abs(r).toFixed(2)}R`;
}

/** A bare ratio, e.g. 4.0× / 0.8×, or "—" when undefined. */
export function ratio(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}×`;
}

export function qty(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Sign class for coloring: "pos" / "neg" / "". */
export function signClass(value: number | null): string {
  if (value === null || value === 0) return "";
  return value > 0 ? "pos" : "neg";
}

export function date(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human hold duration from seconds, e.g. "3h", "2d", "3w". null → open. */
export function holdTime(seconds: number | null): string {
  if (seconds === null) return "open";
  const h = seconds / 3600;
  if (h < 1) return `${Math.round(seconds / 60)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)}d`;
  return `${Math.round(d / 7)}w`;
}
