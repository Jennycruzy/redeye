import type { XyzCandle } from "@redeye/shared";
import { describe, expect, it } from "vitest";
import { createNightService, latestWindow, windowClosingAt, type NightSources } from "./night.js";

// Thursday 8 Oct 2026: close 20:00 UTC, Friday open 13:30 UTC; Friday close starts the weekend.
const THU_CLOSE = Date.parse("2026-10-08T20:00:00Z");
const FRI_OPEN = Date.parse("2026-10-09T13:30:00Z");
const FRI_CLOSE = Date.parse("2026-10-09T20:00:00Z");
const MON_OPEN = Date.parse("2026-10-12T13:30:00Z");
const MINUTE = 60_000;

function candle(openTimeMs: number, close: string): XyzCandle {
  return {
    coin: "xyz:NVDA",
    interval: "5m",
    openTimeMs,
    closeTimeMs: openTimeMs + 5 * MINUTE - 1,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
    trades: 1
  };
}

describe("which night to show", () => {
  it("shows the running window during the night", () => {
    expect(latestWindow(THU_CLOSE + 3 * 60 * MINUTE)).toEqual({
      kind: "overnight",
      closeTs: THU_CLOSE,
      openTs: FRI_OPEN
    });
  });

  it("shows the night that just ended while the market is open", () => {
    expect(latestWindow(FRI_OPEN + 60 * MINUTE)).toMatchObject({ closeTs: THU_CLOSE });
  });

  it("shows the weekend from Friday's close until Monday's open", () => {
    expect(latestWindow(Date.parse("2026-10-10T12:00:00Z"))).toEqual({
      kind: "weekend",
      closeTs: FRI_CLOSE,
      openTs: MON_OPEN
    });
  });

  it("accepts only times at which a window starts", () => {
    expect(windowClosingAt(THU_CLOSE).openTs).toBe(FRI_OPEN);
    expect(() => windowClosingAt(THU_CLOSE + MINUTE)).toThrow("No off-hours window starts");
  });
});

describe("night trace", () => {
  function service(now: number) {
    const calls: Array<[string, number, number]> = [];
    const sources: NightSources = {
      candles: async (ticker, _interval, startMs, endMs) => {
        calls.push([ticker, startMs, endMs]);
        return [
          candle(THU_CLOSE + 10 * MINUTE, "231.10"),
          // Out of order, and one candle from before the close that must be left out.
          candle(THU_CLOSE, "230.90"),
          candle(THU_CLOSE - 5 * MINUTE, "229.00")
        ];
      },
      close: async (_ticker, nyDate) => ({
        value: "230.48",
        date: nyDate,
        source: "nasdaq:NVDA:quote-close"
      }),
      now: () => now
    };
    return { trace: createNightService(sources), calls };
  }

  it("returns the window's 24/7 prices from the close to now, with that day's close", async () => {
    const now = THU_CLOSE + 20 * MINUTE;
    const { trace, calls } = service(now);
    const result = await trace("nvda");
    expect(calls).toEqual([["NVDA", THU_CLOSE, now]]);
    expect(result).toMatchObject({
      ticker: "NVDA",
      phase: "live",
      window: { kind: "overnight", closeTs: THU_CLOSE, openTs: FRI_OPEN },
      close: { value: "230.48", date: "2026-10-08" },
      source: "hyperliquid:xyz:NVDA 5m candles"
    });
    expect(result.points).toEqual([
      [THU_CLOSE + 5 * MINUTE, "230.90"],
      [THU_CLOSE + 15 * MINUTE, "231.10"]
    ]);
  });

  it("stops at the open for a finished window and keeps it cached", async () => {
    const now = FRI_OPEN + 2 * 60 * MINUTE;
    const { trace, calls } = service(now);
    const first = await trace("NVDA", THU_CLOSE);
    expect(first.phase).toBe("finished");
    expect(calls[0]?.[2]).toBe(FRI_OPEN);
    await trace("NVDA", THU_CLOSE);
    expect(calls).toHaveLength(1);
  });

  it("refuses a window that has not started and a bad ticker", async () => {
    const { trace } = service(THU_CLOSE - MINUTE);
    await expect(trace("NVDA", THU_CLOSE)).rejects.toMatchObject({ code: "WINDOW_NOT_STARTED" });
    await expect(trace("nv da")).rejects.toMatchObject({ code: "TICKER_INVALID" });
  });
});
