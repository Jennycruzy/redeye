import { describe, expect, it } from "vitest";
import type { RwaToken, SourceRecord } from "./types.js";

describe("shared source types", () => {
  it("keeps precise token multipliers as strings", () => {
    const token: RwaToken = {
      chainId: "56",
      contractAddress: "0x0000000000000000000000000000000000000001",
      symbol: "TESTB",
      ticker: "TEST",
      wrapper: "bStock",
      multiplier: "1.000778223752807865",
      decimals: 18
    };

    expect(token.multiplier).toBe("1.000778223752807865");
  });

  it("requires source timing on every recorded response", () => {
    const record: SourceRecord<{ ok: true }> = {
      v: 1,
      fetchedAt: "2026-10-05T00:00:00.000Z",
      completedAt: "2026-10-05T00:00:00.100Z",
      request: { method: "GET", url: "https://example.invalid/source" },
      response: { status: 200, ok: true, body: { ok: true } }
    };

    expect(record.response.status).toBe(200);
  });
});
