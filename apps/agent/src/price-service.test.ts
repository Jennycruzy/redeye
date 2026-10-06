import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseBstockList,
  parseHistoricalPrices,
  parseXyzEquityPrices,
  type NasdaqDailyPrice
} from "@redeye/clients";
import type { GeckoPoolSnapshot, SourceRecord } from "@redeye/shared";
import { PriceService, type PriceServiceSources } from "./price-service.js";

async function fixture<T>(name: string): Promise<SourceRecord<T>> {
  const path = new URL(`../../../data/fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as SourceRecord<T>;
}

const poolAddress = "0x172fcd41e0913e95784454622d1c3724f546f849";
const fixedNow = Date.parse("2026-10-05T22:40:30.000Z");

async function sources(): Promise<PriceServiceSources> {
  const real = await fixture<unknown>("hyperliquid/xyz-equities-recorded-subset.json");
  const tokens = await fixture<unknown>("binance/rwa-bstock-list.json");
  const historicalSource = await fixture<unknown>("nasdaq/nvda-historical-2026-10-02.json");
  const historical = {
    ...historicalSource,
    fetchedAt: "2026-10-05T22:40:00.000Z",
    completedAt: "2026-10-05T22:40:01.000Z"
  };
  const pool = {
    v: 1 as const,
    fetchedAt: "2026-10-05T22:40:20.000Z",
    completedAt: "2026-10-05T22:40:21.000Z",
    request: {
      method: "GET" as const,
      url: `https://api.geckoterminal.com/api/v2/networks/bsc/pools/${poolAddress}`
    },
    response: { status: 200, ok: true, body: {} }
  } satisfies SourceRecord<unknown>;
  const parsedPool: GeckoPoolSnapshot = {
    network: "bsc",
    address: poolAddress,
    name: "NVDA / USDT",
    poolCreatedAt: "2026-09-01T00:00:00Z",
    baseTokenPriceUsd: "235.00",
    quoteTokenPriceUsd: "1",
    reserveUsd: "4353526",
    volume24hUsd: "8000000"
  };
  return {
    real: async () => real,
    parseReal: parseXyzEquityPrices,
    tokens: async () => tokens,
    parseTokens: parseBstockList,
    historical: async (...args: [string, string, string]) => {
      void args;
      return historical;
    },
    parseHistorical: parseHistoricalPrices,
    pool: async () => pool,
    parsePool: () => parsedPool
  };
}

describe("source-backed price service", () => {
  it("records close, 24/7 and token prices with source paths", async () => {
    const rawRoot = await mkdtemp(`${tmpdir()}/redeye-price-`);
    const snapshots: unknown[] = [];
    const health: unknown[] = [];
    try {
      const service = new PriceService({
        rawRoot,
        poolMap: {
          NVDA: {
            address: poolAddress,
            observedLiquidityUsd: "4353526",
            createdAtMs: 1785310965000
          }
        },
        sources: await sources(),
        now: () => fixedNow,
        saveSnapshot: async (snapshot) => {
          snapshots.push(snapshot);
        },
        saveHealth: async (snapshot) => {
          health.push(snapshot);
        }
      });

      const result = await service.refresh(["NVDA"]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ state: "ok", ticker: "NVDA" });
      if (result[0]?.state !== "ok") return;
      expect(result[0].close.value).toBe("233.95");
      expect(result[0].real.value).toBe("239.455");
      expect(Number(result[0].token.value)).toBeCloseTo(235 / Number("1.000778223752807865"), 10);
      expect(result[0].close.sourceRecordPath).toContain("raw/nasdaq-NVDA/");
      expect(result[0].real.source).toBe("hyperliquid:xyz:NVDA");
      expect(result[0].pool.address).toBe(poolAddress);
      expect(snapshots).toHaveLength(1);
      expect(health).toHaveLength(1);

      const rawSources = await readdir(`${rawRoot}/raw`);
      expect(rawSources.sort()).toEqual([
        "binance-rwa-bstock-list",
        "gecko-NVDA",
        "hyperliquid",
        "nasdaq-NVDA"
      ]);
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
    }
  });

  it("accepts source records fetched after the refresh started", async () => {
    const rawRoot = await mkdtemp(`${tmpdir()}/redeye-price-timing-`);
    try {
      let clockCalls = 0;
      const service = new PriceService({
        rawRoot,
        poolMap: {
          NVDA: {
            address: poolAddress,
            observedLiquidityUsd: "4353526",
            createdAtMs: 1785310965000
          }
        },
        sources: await sources(),
        now: () => {
          clockCalls += 1;
          return clockCalls === 1
            ? Date.parse("2026-10-05T22:40:00.000Z")
            : Date.parse("2026-10-05T22:40:30.000Z");
        }
      });

      const result = await service.refresh(["NVDA"]);
      expect(result[0]).toMatchObject({ state: "ok", ticker: "NVDA" });
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
    }
  });

  it("refuses a stale 24/7 price instead of using a default", async () => {
    const rawRoot = await mkdtemp(`${tmpdir()}/redeye-price-stale-`);
    try {
      const serviceSources = await sources();
      const real = await fixture<unknown>("hyperliquid/xyz-equities-recorded-subset.json");
      const staleReal = { ...real, fetchedAt: "2026-10-05T22:35:00.000Z" };
      serviceSources.real = async () => staleReal;
      const service = new PriceService({
        rawRoot,
        poolMap: {
          NVDA: {
            address: poolAddress,
            observedLiquidityUsd: "4353526",
            createdAtMs: 1785310965000
          }
        },
        sources: serviceSources,
        now: () => fixedNow
      });

      const result = await service.refresh(["NVDA"]);
      expect(result[0]).toMatchObject({
        state: "error",
        error: { code: "REAL_PRICE_UNAVAILABLE" }
      });
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid historical rows rather than inventing a close", async () => {
    const rawRoot = await mkdtemp(`${tmpdir()}/redeye-price-history-`);
    try {
      const serviceSources = await sources();
      serviceSources.parseHistorical = () => [] as NasdaqDailyPrice[];
      const service = new PriceService({
        rawRoot,
        poolMap: {
          NVDA: {
            address: poolAddress,
            observedLiquidityUsd: "4353526",
            createdAtMs: 1785310965000
          }
        },
        sources: serviceSources,
        now: () => fixedNow
      });

      const result = await service.refresh(["NVDA"]);
      expect(result[0]).toMatchObject({ state: "error", error: { code: "SOURCE_UNAVAILABLE" } });
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
    }
  });

  it("reports a missing real-price market explicitly", async () => {
    const rawRoot = await mkdtemp(`${tmpdir()}/redeye-price-missing-`);
    try {
      const serviceSources = await sources();
      serviceSources.parseReal = () => [];
      const service = new PriceService({
        rawRoot,
        poolMap: {
          NVDA: {
            address: poolAddress,
            observedLiquidityUsd: "4353526",
            createdAtMs: 1785310965000
          }
        },
        sources: serviceSources,
        now: () => fixedNow
      });

      const result = await service.refresh(["NVDA"]);
      expect(result[0]).toMatchObject({
        state: "error",
        error: { code: "REAL_PRICE_UNAVAILABLE" }
      });
    } finally {
      await rm(rawRoot, { recursive: true, force: true });
    }
  });
});
