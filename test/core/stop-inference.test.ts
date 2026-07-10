import { test, expect } from "bun:test";
import { inferStops } from "../../src/core/stop-inference";
import { buildTrades } from "../../src/core/trade-builder";
import { fill, order } from "../helpers";

// A long trade opened at t=60000 (BUY 100 @ 10), still open.
function longTrade() {
  return buildTrades([fill("BUY", 100, 10, { time: 60_000 })])[0]!;
}

test("detects a separate protective SELL STOP for a long", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBe(9);
});

test("detects a take-profit limit above entry for a long", () => {
  const t = longTrade();
  const orders = [order("SELL", "LIMIT", 100, { price: 13, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveTp).toBe(13);
});

test("latest matching stop wins (stop was trailed up)", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000 }),
    order("SELL", "STOP", 100, { triggerPrice: 9.5, createTime: 180_000 }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBe(9.5);
});

test("ignores a BUY stop (wrong side for a long)", () => {
  const t = longTrade();
  const orders = [order("BUY", "STOP", 100, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores a stop on a bigger qty than the position", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 500, { triggerPrice: 9, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores an order on a different symbol/account", () => {
  const t = longTrade();
  const orders = [
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, symbol: "TSLA" }),
    order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 120_000, account: "other" }),
  ];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("ignores an order placed before the trade opened", () => {
  const t = longTrade(); // opens at 60000
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 9, createTime: 30_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("a SELL STOP above entry is not a stop-loss (wrong price side)", () => {
  const t = longTrade();
  const orders = [order("SELL", "STOP", 100, { triggerPrice: 11, createTime: 120_000 })];
  expect(inferStops(t, orders).effectiveStop).toBeNull();
});

test("short trade: BUY stop above entry is the stop-loss", () => {
  const short = buildTrades([fill("SELL", 100, 20, { time: 60_000 })])[0]!;
  const orders = [order("BUY", "STOP", 100, { triggerPrice: 22, createTime: 120_000 })];
  expect(inferStops(short, orders).effectiveStop).toBe(22);
});

test("no orders → null stop and tp", () => {
  const t = longTrade();
  expect(inferStops(t, [])).toEqual({ effectiveStop: null, effectiveTp: null });
});
