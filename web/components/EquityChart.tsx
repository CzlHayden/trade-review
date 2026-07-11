import { useEffect, useRef } from "react";
import {
  createChart,
  AreaSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

/** Read resolved theme colors from CSS custom properties (the canvas can't use CSS vars directly). */
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim() || "#888";
  return {
    text: v("--text-muted"),
    grid: v("--border"),
    accent: v("--accent"),
    pos: v("--pos"),
    neg: v("--neg"),
  };
}

/** Equity curve for ONE currency. `points` are {time: epoch ms, value: cumPnl}, ascending. Duplicate
 * timestamps (same-second closes) are collapsed keeping the later cumulative value — Lightweight
 * Charts requires strictly ascending unique times. */
export function EquityChart({
  points,
  themeKey,
}: {
  points: Array<{ time: number; value: number }>;
  themeKey: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);

  // Create once (tolerate StrictMode double-mount); dispose on unmount.
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      height: 200,
      layout: { background: { color: "transparent" }, fontSize: 11, attributionLogo: false },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false },
      grid: { horzLines: { style: LineStyle.Dotted }, vertLines: { visible: false } },
      handleScale: false,
      handleScroll: false,
    });
    const s = c.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    chart.current = c;
    series.current = s;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  // Push data (dedupe + convert ms→seconds).
  useEffect(() => {
    if (!series.current) return;
    const bySecond = new Map<number, number>();
    for (const p of points) bySecond.set(Math.floor(p.time / 1000), p.value);
    const data = [...bySecond.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, value]) => ({ time: t as UTCTimestamp, value }));
    series.current.setData(data);
    chart.current?.timeScale().fitContent();
  }, [points]);

  // Re-theme on toggle (applyOptions, not recreate).
  useEffect(() => {
    if (!chart.current || !series.current) return;
    const c = themeColors();
    const up = points.length > 0 && points[points.length - 1]!.value >= 0;
    const line = up ? c.pos : c.neg;
    chart.current.applyOptions({
      layout: { textColor: c.text },
      grid: { horzLines: { color: c.grid } },
    });
    series.current.applyOptions({
      lineColor: line,
      topColor: `color-mix(in srgb, ${line} 28%, transparent)`,
      bottomColor: `color-mix(in srgb, ${line} 2%, transparent)`,
    });
  }, [themeKey, points]);

  return <div ref={el} style={{ width: "100%", height: 200 }} />;
}
