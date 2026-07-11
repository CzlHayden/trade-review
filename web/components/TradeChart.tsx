import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type IPriceLine,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { Candle, RawFill } from "../lib/api";

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || "#888";
  return {
    text: v("--text-muted"),
    grid: v("--border"),
    up: v("--pos"),
    down: v("--neg"),
    accent: v("--accent"),
    warn: v("--warn"),
  };
}

/** Snap a fill's epoch-ms time to the bar it falls in (the last candle whose time ≤ fill), so a
 * marker sits on an existing daily/hourly bar rather than being dropped by Lightweight Charts. */
function snap(fillMs: number, barsSec: number[]): UTCTimestamp {
  const s = Math.floor(fillMs / 1000);
  let chosen = barsSec[0] ?? s;
  for (const b of barsSec) {
    if (b <= s) chosen = b;
    else break;
  }
  return chosen as UTCTimestamp;
}

export interface ChartMarks {
  avgEntry: number;
  effectiveStop: number | null;
  effectiveTp: number | null;
  direction: "LONG" | "SHORT";
}

/** Marked-up candlestick chart: candles + a marker per fill (buy ▲ below / sell ▼ above) + price
 * lines for avg entry, effective stop, and take-profit. Pure presentation from data the detail
 * already holds. */
export function TradeChart({
  candles,
  fills,
  marks,
  themeKey,
}: {
  candles: Candle[];
  fills: RawFill[];
  marks: ChartMarks;
  themeKey: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      height: 340,
      layout: { background: { color: "transparent" }, fontSize: 11, attributionLogo: false },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
      grid: { horzLines: { style: LineStyle.Dotted }, vertLines: { visible: false } },
    });
    const s = c.addSeries(CandlestickSeries, { borderVisible: false, wickVisible: true });
    series.current = s;
    chart.current = c;
    markersApi.current = createSeriesMarkers(s, []); // one markers primitive, updated via setMarkers
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
      markersApi.current = null;
      priceLines.current = [];
    };
  }, []);

  useEffect(() => {
    if (!series.current || !chart.current) return;
    const s = series.current;
    // Dedupe + sort candles ascending by second (LWC hard-errors on unsorted/dupes).
    const bySec = new Map<number, Candle>();
    for (const k of candles) bySec.set(Math.floor(k.time / 1000), k);
    const bars = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
    s.setData(
      bars.map(([t, k]) => ({ time: t as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })),
    );

    const barsSec = bars.map(([t]) => t);
    const c = themeColors();
    const markers: SeriesMarker<Time>[] = fills
      .slice()
      .sort((a, b) => a.time - b.time)
      .map((f) => ({
        time: snap(f.time, barsSec),
        position: f.side === "BUY" ? "belowBar" : "aboveBar",
        color: f.side === "BUY" ? c.up : c.down,
        shape: f.side === "BUY" ? "arrowUp" : "arrowDown",
        text: `${f.side === "BUY" ? "+" : "−"}${f.qty}`,
      }));
    markersApi.current?.setMarkers(markers); // replace (not stack) markers

    // Replace price lines: remove the previous set, then draw the current entry/stop/tp.
    for (const line of priceLines.current) s.removePriceLine(line);
    priceLines.current = [];
    priceLines.current.push(
      s.createPriceLine({ price: marks.avgEntry, color: c.accent, lineWidth: 1, lineStyle: LineStyle.Dashed, title: "entry" }),
    );
    if (marks.effectiveStop !== null)
      priceLines.current.push(
        s.createPriceLine({ price: marks.effectiveStop, color: c.down, lineWidth: 1, lineStyle: LineStyle.Solid, title: "stop" }),
      );
    if (marks.effectiveTp !== null)
      priceLines.current.push(
        s.createPriceLine({ price: marks.effectiveTp, color: c.up, lineWidth: 1, lineStyle: LineStyle.Dashed, title: "tp" }),
      );

    s.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    chart.current.applyOptions({ layout: { textColor: c.text }, grid: { horzLines: { color: c.grid } } });
    chart.current.timeScale().fitContent();
  }, [candles, fills, marks, themeKey]);

  // The container must ALWAYS render so the chart's init effect binds to a live ref (a conditional
  // early-return would leave the ref null on the first, still-loading render and never re-init).
  return (
    <div className="card" style={{ position: "relative", width: "100%", height: 340 }}>
      <div ref={el} style={{ width: "100%", height: "100%" }} />
      {candles.length === 0 && (
        <div
          className="empty"
          style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          No candles for this window (source unavailable or unsupported market).
        </div>
      )}
    </div>
  );
}
