import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@redeye/shared";
import {
  callRpc,
  ClientError,
  parseBstockList,
  parseAssetMultiplier,
  parseAssetMarketStatus,
  parseEarningsCalendar,
  parseGeckoPool,
  parseChartPoints,
  parseHistoricalPrices,
  parseMarketStatus,
  parseXyzCandles,
  parseXyzEquityPrices,
  parseSecSubmissions,
  assertUsableXyzPrice,
  storeRawRecord,
  validateMultiplierAgreement
} from "./index.js";

async function fixture(name: string): Promise<SourceRecord<unknown>> {
  const path = new URL(`../../../data/fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as SourceRecord<unknown>;
}

describe("recorded source clients", () => {
  it("parses recorded bStock rows without converting precise multipliers", async () => {
    const record = await fixture("binance/rwa-bstock-list.json");
    const tokens = parseBstockList(record);

    expect(tokens).toHaveLength(3);
    expect(tokens.find((token) => token.ticker === "NVDA")?.multiplier).toBe(
      "1.000778223752807865"
    );
    expect(tokens.every((token) => token.chainId === "56")).toBe(true);
  });

  it("keeps wrapper identity explicit when parsing a typed RWA list", async () => {
    const record = await fixture("binance/rwa-bstock-list.json");
    const tokens = parseBstockList(record);
    expect(tokens.every((token) => token.wrapper === "bStock")).toBe(true);
  });

  it("parses market status and preserves off-hours data", async () => {
    const record = await fixture("binance/rwa-market-status.json");
    const status = parseMarketStatus(record);

    expect(status.marketStatus).toBe("regular");
    expect(status.offhours?.openState).toBe(false);
    expect(status.reasonCode).toBeNull();
  });

  it("preserves the bStock asset status shape with a null market status", () => {
    const status = parseAssetMarketStatus({
      v: 1,
      fetchedAt: "2026-10-05T00:00:00.000Z",
      completedAt: "2026-10-05T00:00:00.100Z",
      request: { method: "GET", url: "https://example.invalid/status" },
      response: {
        status: 200,
        ok: true,
        body: {
          success: true,
          code: "000000",
          data: {
            chainId: "56",
            contractAddress: "0x0000000000000000000000000000000000000001",
            openState: null,
            marketStatus: null,
            reasonCode: "TRADING",
            reasonMsg: null,
            nextOpenTime: null,
            nextCloseTime: null
          }
        }
      }
    });

    expect(status.reasonCode).toBe("TRADING");
    expect(status.marketStatus).toBeNull();
  });

  it("compares long multipliers without losing decimal precision", () => {
    expect(
      validateMultiplierAgreement({
        list: "1.000778223752807865000",
        asset: "1.000778223752807865",
        contract: "1.0007782237528078650"
      })
    ).toEqual({
      list: "1.000778223752807865",
      asset: "1.000778223752807865",
      contract: "1.000778223752807865"
    });
  });

  it("fails loudly when share-count sources disagree", () => {
    expect(() => validateMultiplierAgreement({ list: "1", asset: "10", contract: null })).toThrow(
      "multiplier sources disagree"
    );
  });

  it("parses an optional per-asset multiplier without inventing one", () => {
    const base = {
      v: 1 as const,
      fetchedAt: "2026-10-05T00:00:00.000Z",
      completedAt: "2026-10-05T00:00:00.100Z",
      request: { method: "GET" as const, url: "https://example.invalid/status" },
      response: {
        status: 200,
        ok: true,
        body: {
          success: true,
          code: "000000",
          data: { multiplier: "10.000000000000000000" }
        }
      }
    };
    expect(parseAssetMultiplier(base)).toBe("10.000000000000000000");
    const missing = structuredClone(base);
    const missingData = (missing.response.body as { data: { multiplier?: string } }).data;
    delete missingData.multiplier;
    expect(parseAssetMultiplier(missing)).toBeNull();
  });

  it("parses Nasdaq estimates without filling empty EPS values", async () => {
    const record = await fixture("nasdaq/earnings-2026-10-05.json");
    const rows = parseEarningsCalendar(record);

    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.symbol === "NCPL")?.epsForecast).toBe("");
    expect(rows.find((row) => row.symbol === "AEHR")?.numberOfEstimates).toBe(2);
  });

  it("takes the official open and close from Nasdaq daily history", async () => {
    const record = await fixture("nasdaq/nvda-historical-2026-10-02.json");
    const rows = parseHistoricalPrices(record);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "10/02/2026",
      open: "236.055",
      close: "233.95"
    });
  });

  it("uses the published 5 October daily row for the official open", async () => {
    const record = await fixture("nasdaq/nvda-historical-2026-10-05.json");
    const rows = parseHistoricalPrices(record);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "10/05/2026",
      open: "236.09",
      close: "238.90"
    });
  });

  it("maps Nasdaq chart x values from New York wall-clock time", async () => {
    const record = await fixture("nasdaq/nvda-chart-points-2026-10-05.json");
    const points = parseChartPoints(record);

    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ localDateTime: "9:30 AM ET", price: "235.61" });
    expect(new Date(points[0]?.atMs ?? 0).toISOString()).toBe("2026-10-05T13:30:00.000Z");
    expect(points[1]).toMatchObject({ localDateTime: "1:30 PM ET", price: "237.4916" });
    expect(new Date(points[1]?.atMs ?? 0).toISOString()).toBe("2026-10-05T17:30:00.000Z");
  });

  it("fails loudly when a source response loses a required field", async () => {
    const record = await fixture("binance/rwa-bstock-list.json");
    const body = record.response.body as { data: Array<Record<string, unknown>> };
    delete body.data[0]?.multiplier;

    expect(() => parseBstockList(record)).toThrowError(ClientError);
    expect(() => parseBstockList(record)).toThrow("data[0].multiplier");
  });

  it("extracts only 8-K and 6-K filings and preserves acceptance time", async () => {
    const record = await fixture("sec/nvda-submissions.json");
    const filings = parseSecSubmissions(record, "1045810");

    expect(filings).toHaveLength(5);
    expect(filings[1]).toMatchObject({
      cik: "0001045810",
      form: "8-K",
      accessionNumber: "0001045810-26-000073",
      acceptanceDateTime: "2026-08-26T20:21:19.000Z",
      items: "2.02,9.01"
    });
  });

  it("parses GeckoTerminal pool numbers as strings", async () => {
    const record = await fixture("gecko/bsc-pool.json");
    const pool = parseGeckoPool(record);

    expect(pool.address).toBe("0x172fcd41e0913e95784454622d1c3724f546f849");
    expect(pool.reserveUsd).toBe("13546025.6008");
    expect(pool.volume24hUsd).toBe("104444313.747797");
  });

  it("parses xyz equity prices and keeps the source and precise volume", async () => {
    const record = await fixture("hyperliquid/xyz-equities-recorded-subset.json");
    const prices = parseXyzEquityPrices(record);
    const nvda = prices.find((price) => price.ticker === "NVDA");

    expect(prices).toHaveLength(3);
    expect(nvda).toMatchObject({
      coin: "xyz:NVDA",
      midPrice: "239.455",
      markPrice: "239.47",
      price: "239.455",
      dayNotionalVolumeUsd: "56394452.6308300048",
      source: "hyperliquid:xyz:NVDA"
    });
  });

  it("falls back to the mark price when the xyz mid is missing", async () => {
    const record = await fixture("hyperliquid/xyz-equities-recorded-subset.json");
    const body = record.response.body as [
      { universe: Array<Record<string, unknown>> },
      Array<Record<string, unknown>>
    ];
    if (body[1][1]) body[1][1].midPx = null;

    expect(parseXyzEquityPrices(record)[1]).toMatchObject({
      midPrice: null,
      markPrice: "239.47",
      price: "239.47"
    });
  });

  it("rejects stale xyz prices and prices in the wrong unit", async () => {
    const record = await fixture("hyperliquid/xyz-equities-recorded-subset.json");
    const nvda = parseXyzEquityPrices(record).find((price) => price.ticker === "NVDA");
    expect(nvda).toBeDefined();
    if (!nvda) return;

    expect(assertUsableXyzPrice(nvda, "233.95", Date.parse("2026-10-05T22:41:54.000Z"))).toBe(nvda);
    expect(() =>
      assertUsableXyzPrice(nvda, "233.95", Date.parse("2026-10-05T22:41:55.000Z"))
    ).toThrow("fresh fetch time");
    expect(() =>
      assertUsableXyzPrice(
        { ...nvda, price: "100", midPrice: "100" },
        "200",
        Date.parse("2026-10-05T22:40:00.000Z")
      )
    ).toThrow("unit check");
  });

  it("parses recorded xyz candles without converting decimal fields", async () => {
    const record = await fixture("hyperliquid/nvda-candles-2026-10-05.json");
    const candles = parseXyzCandles(record);

    expect(candles).toHaveLength(6);
    expect(candles[0]).toMatchObject({
      coin: "xyz:NVDA",
      interval: "1m",
      openTimeMs: 1791230400000,
      open: "238.95",
      close: "238.89",
      volume: "686.573",
      trades: 81
    });
  });

  it("stores a raw source record below source and fetch date", async () => {
    const root = await mkdtemp(`${tmpdir()}/redeye-raw-`);
    try {
      const record = await fixture("sec/nvda-submissions.json");
      const path = await storeRawRecord(root, "sec", record);

      expect(path).toContain("raw/sec/2026-10-05/");
      expect(path.endsWith(".json")).toBe(true);
      expect(JSON.parse(await readFile(`${root}/${path}`, "utf8"))).toMatchObject({ v: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns an RPC result and surfaces RPC errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x38" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "busy" } }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(callRpc("https://rpc.invalid", "eth_chainId")).resolves.toBe("0x38");
    await expect(callRpc("https://rpc.invalid", "eth_blockNumber")).rejects.toThrow("busy");

    vi.unstubAllGlobals();
  });
});
