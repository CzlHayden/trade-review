import { useEffect, useRef } from "react";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import type { Candle, RawFill, Drawing } from "../lib/api";

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) => cs.getPropertyValue(n).trim() || fallback;
  return {
    text: v("--text-muted", "#888"),
    grid: v("--border", "#333"),
    up: v("--pos", "#26a69a"),
    down: v("--neg", "#ef5350"),
    accent: v("--accent", "#4c8dff"),
    warn: v("--warn", "#e0a341"),
    axis: v("--text-faint", "#777"),
  };
}

export type Res = "1d" | "1h" | "15m";
function periodFor(res: Res) {
  if (res === "1h") return { type: "hour" as const, span: 1 };
  if (res === "15m") return { type: "minute" as const, span: 15 };
  return { type: "day" as const, span: 1 };
}

/** klinecharts style overrides sampled from our CSS theme, so the chart re-themes with the app. */
function chartStyles(c: ReturnType<typeof themeColors>) {
  return {
    grid: { horizontal: { color: c.grid, style: "dashed" as const }, vertical: { show: false } },
    candle: {
      bar: {
        upColor: c.up, downColor: c.down,
        upBorderColor: c.up, downBorderColor: c.down,
        upWickColor: c.up, downWickColor: c.down,
      },
      priceMark: { high: { color: c.text }, low: { color: c.text }, last: { text: { color: "#fff" } } },
      tooltip: { legend: { color: c.text } },
    },
    indicator: { tooltip: { legend: { color: c.text } } },
    xAxis: { axisLine: { color: c.grid }, tickLine: { color: c.grid }, tickText: { color: c.axis } },
    yAxis: { axisLine: { color: c.grid }, tickLine: { color: c.grid }, tickText: { color: c.axis } },
    crosshair: {
      horizontal: { text: { backgroundColor: c.accent } },
      vertical: { text: { backgroundColor: c.accent } },
    },
  };
}

export interface ChartMarks {
  avgEntry: number;
  plannedStop: number | null; // manual ?? initial — the R basis
  effectiveStop: number | null; // last active/trailing stop
  effectiveTp: number | null;
  riskKnown: boolean; // dash the planned stop when risk was not computed (seed/profit-side)
  direction: "LONG" | "SHORT";
}

function toKline(c: Candle): KLineData {
  return { timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

const MARKS = "marks"; // our locked trade marks
const USER = "user"; // user drawings (persisted)

// klinecharts v10 built-in OVERLAYS only (its `rect` is a figure, not an overlay — createOverlay
// would no-op). Segment/horizontalStraightLine/fibonacciLine are real overlay templates.
const TOOLS: Array<{ name: string; label: string }> = [
  { name: "segment", label: "Line" },
  { name: "horizontalStraightLine", label: "H-line" },
  { name: "fibonacciLine", label: "Fib" },
];

/** Marked-up candlestick chart on klinecharts: candles + volume, fill markers, entry/stop/TP lines,
 * a 1D/1H/15m resolution toggle, and drawing tools whose annotations persist per trade. */
export function TradeChart({
  symbol,
  candles,
  res,
  requestedRes,
  onRes,
  focusFrom,
  focusTo,
  fills,
  marks,
  themeKey,
  savedDrawings,
  onDrawingsChange,
}: {
  symbol: string;
  candles: Candle[];
  res: Res;
  requestedRes: Res;
  onRes: (r: Res) => void;
  focusFrom: number;
  focusTo: number;
  fills: RawFill[];
  marks: ChartMarks;
  themeKey: string;
  savedDrawings: Drawing[];
  onDrawingsChange: (d: Drawing[]) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const bars = useRef<KLineData[]>([]);
  const hydrating = useRef(false); // suppress persistence while we recreate saved overlays
  const onChange = useRef(onDrawingsChange);
  onChange.current = onDrawingsChange;

  // Init once. dispose() the INSTANCE in cleanup (dispose(element) can't find it — our div has no id).
  useEffect(() => {
    if (!el.current) return;
    const c = init(el.current);
    if (!c) return;
    chart.current = c;
    c.setStyles(chartStyles(themeColors()));
    c.setDataLoader({ getBars: ({ type, callback }) => callback(type === "init" ? bars.current : [], false) });
    c.createIndicator("VOL", false);
    return () => {
      dispose(c);
      chart.current = null;
    };
  }, []);

  // Load data on candle/resolution change, then focus the trade window.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    bars.current = candles.map(toKline).sort((a, b) => a.timestamp - b.timestamp);
    const precision = marks.avgEntry > 0 && marks.avgEntry < 1 ? 4 : 2; // sub-$1 tickers tick finer
    c.setSymbol({ ticker: symbol, pricePrecision: precision, volumePrecision: 0 });
    c.setPeriod(periodFor(res));
    c.resetData();
    // Guard the empty case: scrollToTimestamp indexes into the bar list and throws on []
    // (unsupported market / Yahoo outage → ladder exhausts → candles []), which would blank the app.
    if (bars.current.length > 0 && focusTo > 0) c.scrollToTimestamp(focusTo, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, res, candles.length, candles[0]?.time, candles[candles.length - 1]?.time]);

  // Serialize the user's drawings to our persistence shape (timestamp+value only; strip dataIndex).
  const persist = () => {
    const c = chart.current;
    if (!c || hydrating.current) return;
    const drawings: Drawing[] = c.getOverlays({ groupId: USER }).map((o) => ({
      name: o.name,
      points: (o.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
    }));
    onChange.current(drawings);
  };

  const startDraw = (name: string) => {
    chart.current?.createOverlay({
      name,
      groupId: USER,
      onDrawEnd: () => (persist(), false),
      onPressedMoveEnd: () => (persist(), false),
      onRemoved: () => (persist(), false),
    });
  };

  const clearDrawings = () => {
    chart.current?.removeOverlay({ groupId: USER });
    persist();
  };

  // Draw/redraw the locked marks; also re-theme (both depend on resolved CSS colors via themeKey).
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.setStyles(chartStyles(themeColors()));
    c.removeOverlay({ groupId: MARKS });
    if (bars.current.length === 0) return;
    const col = themeColors();
    const line = (value: number, color: string, dashed: boolean) =>
      c.createOverlay({
        name: "horizontalStraightLine",
        groupId: MARKS,
        lock: true,
        points: [{ value }],
        styles: { line: { color, style: dashed ? "dashed" : "solid", size: 1 } },
      });
    line(marks.avgEntry, col.accent, true); // entry — blue
    if (marks.plannedStop !== null) line(marks.plannedStop, col.down, !marks.riskKnown); // planned stop — red
    if (marks.effectiveStop !== null && marks.effectiveStop !== marks.plannedStop)
      line(marks.effectiveStop, col.warn, false); // effective stop — amber
    if (marks.effectiveTp !== null) line(marks.effectiveTp, col.up, true); // tp — green
    for (const f of fills) {
      c.createOverlay({
        name: "simpleAnnotation",
        groupId: MARKS,
        lock: true,
        points: [{ timestamp: f.time, value: f.price }],
        extendData: `${f.side === "BUY" ? "+" : "−"}${f.qty}`,
        styles: { text: { color: f.side === "BUY" ? col.up : col.down } },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, fills, themeKey, candles.length]);

  // Recreate saved user drawings on load / trade change (replace-not-accumulate). Each in its own
  // try/catch so one bad row can't poison the chart; `hydrating` blocks the load→save echo.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    hydrating.current = true;
    c.removeOverlay({ groupId: USER });
    for (const d of savedDrawings) {
      try {
        c.createOverlay({
          name: d.name,
          groupId: USER,
          points: d.points,
          onDrawEnd: () => (persist(), false),
          onPressedMoveEnd: () => (persist(), false),
          onRemoved: () => (persist(), false),
        });
      } catch {
        /* skip a malformed saved overlay */
      }
    }
    hydrating.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedDrawings, candles.length]);

  const toggle = (r: Res) => (
    <button
      key={r}
      className={`btn${requestedRes === r ? " btn-primary" : ""}`}
      style={{ padding: "2px 9px" }}
      onClick={() => onRes(r)}
    >
      {r === "1d" ? "1D" : r === "1h" ? "1H" : "15m"}
    </button>
  );

  return (
    <div>
      <div className="toolbar" style={{ marginBottom: 6, gap: 6 }}>
        {(["1d", "1h", "15m"] as Res[]).map(toggle)}
        <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
        {TOOLS.map((t) => (
          <button key={t.name} className="btn" style={{ padding: "2px 9px" }} onClick={() => startDraw(t.name)}>
            {t.label}
          </button>
        ))}
        <button className="btn" style={{ padding: "2px 9px" }} onClick={clearDrawings}>
          Clear
        </button>
        {res !== requestedRes && (
          <span className="faint" style={{ fontSize: 11, alignSelf: "center" }}>
            no {requestedRes} data — showing {res}
          </span>
        )}
      </div>
      <div className="card" style={{ position: "relative", width: "100%", height: 380 }}>
        <div ref={el} style={{ width: "100%", height: "100%" }} />
        {candles.length === 0 && (
          <div
            className="empty"
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
          >
            No candles for this window (source unavailable or unsupported market).
          </div>
        )}
      </div>
    </div>
  );
}
