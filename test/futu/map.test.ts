import { test, expect } from "bun:test";
import {
  mapFill,
  mapOrder,
  mapPosition,
  mapAccount,
  currencyForMarket,
  futuSymbol,
  marketName,
  isCancelledFill,
} from "../../src/futu/map";

test("futuSymbol / currencyForMarket / marketName normalize by market", () => {
  expect(futuSymbol("AAPL", 2)).toBe("US.AAPL");
  expect(futuSymbol("00700", 1)).toBe("HK.00700");
  expect(currencyForMarket(2)).toBe("USD");
  expect(currencyForMarket(1)).toBe("HKD");
  expect(marketName(2)).toBe("US");
});

test("marketName is unique per market — HK and HKCC don't share a sync cursor key", () => {
  expect(marketName(1)).toBe("HK");
  expect(marketName(4)).toBe("HKCC"); // must differ from HK, else sync_state collides
  expect(marketName(2)).toBe("US");
});

test("mappers treat SDK default-zero market/cost as absent (protobufjs quirk)", () => {
  // Only secMarket present (trdMarket omitted → arrives as 0): must fall back, not map to UNKNOWN.
  const f = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "AAPL", qty: 1, price: 1, createTimestamp: 1, trdMarket: 0, secMarket: 2 }, "a");
  expect(f.symbol).toBe("US.AAPL");
  expect(f.currency).toBe("USD");
  // averageCostPrice omitted (0) → fall back to dilutedCostPrice.
  const p = mapPosition({ positionSide: 0, code: "AAPL", qty: 1, averageCostPrice: 0, dilutedCostPrice: 7, currency: 2, trdMarket: 2 }, "a", 1);
  expect(p.avgCost).toBe(7);
});

test("the fill's OWN market wins over the queried market (OpenD returns cross-market fills)", () => {
  // A US fill (trdMarket=2) returned under a JP (15) market query must stay US/USD, not JP/JPY.
  const f = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "CRWD", qty: 1, price: 1, createTimestamp: 1, trdMarket: 2, secMarket: 2 }, "a", 15);
  expect(f.symbol).toBe("US.CRWD");
  expect(f.currency).toBe("USD");
});

test("secMarket is translated to its TrdMarket when trdMarket is absent (SG=41 → market 6)", () => {
  const f = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "D05", qty: 1, price: 1, createTimestamp: 1, secMarket: 41 }, "a");
  expect(f.symbol).toBe("SG.D05");
  expect(f.currency).toBe("SGD");
});

test("the queried market is only a last-resort fallback when the row carries no market", () => {
  const f = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "AAPL", qty: 1, price: 1, createTimestamp: 1 }, "a", 2);
  expect(f.symbol).toBe("US.AAPL"); // no trdMarket/secMarket on the row → fall back to queried (2=US)
});

test("a nonzero-but-unmapped secMarket (FX=91) is UNKNOWN, never the queried market's currency", () => {
  // Guards money-math: an FX row returned under an HK query must not be labeled HKD.
  const f = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "EURUSD", qty: 1, price: 1, createTimestamp: 1, secMarket: 91 }, "a", 1);
  expect(f.currency).toBe("UNKNOWN"); // segmented safely, not HKD
});

test("ambiguous SH/SZ secMarket resolves to HKCC only when the query says so, else mainland CN", () => {
  const hkcc = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "600000", qty: 1, price: 1, createTimestamp: 1, secMarket: 31 }, "a", 4);
  expect(hkcc.symbol).toBe("HK.600000"); // queried HKCC(4) disambiguates; currency CNH
  expect(hkcc.currency).toBe("CNH");
  const cn = mapFill({ trdSide: 1, fillID: 1, orderID: 1, code: "600000", qty: 1, price: 1, createTimestamp: 1, secMarket: 31 }, "a");
  expect(cn.symbol).toBe("CN.600000"); // no query context → mainland CN default; currency CNH
  expect(cn.currency).toBe("CNH");
});

test("mapFill maps a US buy fill (fee defaults to 0, currency from market, ms from timestamp)", () => {
  const f = mapFill(
    { trdSide: 1, fillID: 123, orderID: 456, code: "AAPL", qty: 100, price: 10.5, createTimestamp: 1_700_000_000, trdMarket: 2 },
    "acc1",
  );
  expect(f).toEqual({
    id: "123", orderId: "456", symbol: "US.AAPL", side: "BUY", qty: 100, price: 10.5,
    fee: 0, currency: "USD", time: 1_700_000_000_000, account: "acc1",
  });
});

test("isCancelledFill flags only OrderFillStatus_Cancelled (1); OK(0)/Changed(2)/absent are kept", () => {
  expect(isCancelledFill({ status: 1 })).toBe(true);
  expect(isCancelledFill({ status: 0 })).toBe(false);
  expect(isCancelledFill({ status: 2 })).toBe(false);
  expect(isCancelledFill({})).toBe(false); // absent → proto default 0 (OK)
});

test("mapFill treats SellShort as SELL", () => {
  expect(
    mapFill({ trdSide: 3, fillID: 1, orderID: 1, code: "X", qty: 1, price: 1, createTimestamp: 1, trdMarket: 2 }, "a").side,
  ).toBe("SELL");
});

test("mapOrder maps a stop order: trigger from auxPrice, type STOP, dead status name", () => {
  const o = mapOrder(
    { trdSide: 2, orderType: 10, orderStatus: 15, orderID: 9, code: "AAPL", qty: 100, price: 0, auxPrice: 9.5, createTimestamp: 100, updateTimestamp: 200, trdMarket: 2 },
    "acc1",
  );
  expect(o.type).toBe("STOP");
  expect(o.triggerPrice).toBe(9.5);
  expect(o.price).toBeNull(); // stop-market has no limit price
  expect(o.status).toBe("CANCELLED_ALL");
  expect(o.createTime).toBe(100_000);
  expect(o.updateTime).toBe(200_000);
  expect(o.symbol).toBe("US.AAPL");
});

test("mapOrder: a trailing stop with omitted auxPrice (decodes as 0) yields triggerPrice null, not 0", () => {
  // protobufjs surfaces the omitted auxPrice as 0; a live "stop @ 0" would poison risk/flags.
  const o = mapOrder(
    { trdSide: 2, orderType: 14, orderStatus: 5, orderID: 7, code: "AAPL", qty: 100, price: 0, auxPrice: 0, trailValue: 5, createTimestamp: 1, trdMarket: 2 },
    "a",
  );
  expect(o.type).toBe("TRAILING_STOP");
  expect(o.triggerPrice).toBeNull();
});

test("currencyForMarket maps HKCC (China-Connect) to CNH, not HKD", () => {
  expect(currencyForMarket(4)).toBe("CNH");
});

test("mapOrder maps a plain limit: type LIMIT, price kept, trigger null", () => {
  const o = mapOrder(
    { trdSide: 1, orderType: 1, orderStatus: 11, orderID: 1, code: "00700", qty: 10, price: 350, createTimestamp: 1, trdMarket: 1 },
    "a",
  );
  expect(o.type).toBe("LIMIT");
  expect(o.price).toBe(350);
  expect(o.triggerPrice).toBeNull();
  expect(o.status).toBe("FILLED_ALL");
});

test("mapOrder: absent update timestamp maps to null updateTime", () => {
  const o = mapOrder(
    { trdSide: 1, orderType: 1, orderStatus: 11, orderID: 1, code: "AAPL", qty: 10, price: 350, createTimestamp: 1, trdMarket: 2 },
    "a",
  );
  expect(o.updateTime).toBeNull();
});

test("mapPosition signs qty by side and picks averageCostPrice", () => {
  const long = mapPosition(
    { positionSide: 0, code: "AAPL", qty: 100, averageCostPrice: 10, currency: 2, trdMarket: 2 },
    "acc1",
    5000,
  );
  expect(long).toEqual({ account: "acc1", symbol: "US.AAPL", qty: 100, avgCost: 10, currency: "USD", time: 5000 });
  const short = mapPosition(
    { positionSide: 1, code: "TSLA", qty: 50, averageCostPrice: 200, currency: 2, trdMarket: 2 },
    "acc1",
    5000,
  );
  expect(short.qty).toBe(-50);
});

test("mapPosition falls back dilutedCostPrice → costPrice when averageCostPrice missing", () => {
  expect(mapPosition({ positionSide: 0, code: "X", qty: 1, dilutedCostPrice: 7, currency: 2, trdMarket: 2 }, "a", 1).avgCost).toBe(7);
  expect(mapPosition({ positionSide: 0, code: "X", qty: 1, costPrice: 3, currency: 2, trdMarket: 2 }, "a", 1).avgCost).toBe(3);
});

test("mapAccount surfaces id/env/markets", () => {
  expect(mapAccount({ accID: 42, trdEnv: 1, trdMarketAuthList: [1, 2] })).toEqual({ id: "42", trdEnv: 1, markets: [1, 2] });
});

test("timestamp falls back to parsing the string form when numeric ts is absent", () => {
  const f = mapFill(
    { trdSide: 1, fillID: 1, orderID: 1, code: "AAPL", qty: 1, price: 1, createTime: "2023-11-14 22:13:20", trdMarket: 2 },
    "a",
  );
  expect(typeof f.time).toBe("number");
  expect(f.time).toBeGreaterThan(1_600_000_000_000);
});
