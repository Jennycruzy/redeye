import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Clients from "@redeye/clients";
import type { SourceRecord } from "@redeye/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchHistoricalPrices = vi.fn<(ticker: string, from: string, to: string) => unknown>();

vi.mock("@redeye/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof Clients>()),
  fetchHistoricalPrices: (ticker: string, from: string, to: string) =>
    Promise.resolve(fetchHistoricalPrices(ticker, from, to))
}));

const { nasdaqOfficialOpen } = await import("./plan-sources.js");

async function fixture(name: string): Promise<SourceRecord<unknown>> {
  const path = new URL(`../../../data/fixtures/nasdaq/${name}`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as SourceRecord<unknown>;
}

describe("official open from Nasdaq", () => {
  let rawRoot: string;
  beforeEach(async () => {
    rawRoot = await mkdtemp(join(tmpdir(), "redeye-open-"));
    fetchHistoricalPrices.mockReset();
  });

  it("asks from the day to the next day, since Nasdaq refuses a same-day range", async () => {
    fetchHistoricalPrices.mockReturnValue(await fixture("nvda-historical-2026-10-05.json"));
    const open = await nasdaqOfficialOpen(rawRoot, "NVDA", "2026-10-05");
    expect(fetchHistoricalPrices).toHaveBeenCalledWith("NVDA", "2026-10-05", "2026-10-06");
    expect(open).toMatchObject({ value: "236.09", source: "nasdaq:NVDA:daily-history" });
  });

  it("crosses a month end when asking for the next day", async () => {
    fetchHistoricalPrices.mockReturnValue(
      await fixture("nvda-historical-2026-10-08-no-row-yet.json")
    );
    await nasdaqOfficialOpen(rawRoot, "NVDA", "2026-10-31");
    expect(fetchHistoricalPrices).toHaveBeenCalledWith("NVDA", "2026-10-31", "2026-11-01");
  });

  it("waits while Nasdaq has not posted the day's row", async () => {
    fetchHistoricalPrices.mockReturnValue(
      await fixture("nvda-historical-2026-10-08-no-row-yet.json")
    );
    expect(await nasdaqOfficialOpen(rawRoot, "NVDA", "2026-10-08")).toBeNull();
  });
});
