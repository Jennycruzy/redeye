import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { SourceRecord } from "@redeye/shared";
import {
  callRpc,
  ClientError,
  parseBstockList,
  parseEarningsCalendar,
  parseGeckoPool,
  parseMarketStatus,
  parseSecSubmissions,
  storeRawRecord
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

  it("parses market status and preserves off-hours data", async () => {
    const record = await fixture("binance/rwa-market-status.json");
    const status = parseMarketStatus(record);

    expect(status.marketStatus).toBe("regular");
    expect(status.offhours?.openState).toBe(false);
    expect(status.reasonCode).toBeNull();
  });

  it("parses Nasdaq estimates without filling empty EPS values", async () => {
    const record = await fixture("nasdaq/earnings-2026-10-05.json");
    const rows = parseEarningsCalendar(record);

    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.symbol === "NCPL")?.epsForecast).toBe("");
    expect(rows.find((row) => row.symbol === "AEHR")?.numberOfEstimates).toBe(2);
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
