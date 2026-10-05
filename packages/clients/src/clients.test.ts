import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { SourceRecord } from "@redeye/shared";
import { ClientError, parseBstockList, parseEarningsCalendar, parseMarketStatus } from "./index.js";

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
});
