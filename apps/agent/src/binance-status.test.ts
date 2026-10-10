import { describe, expect, it } from "vitest";
import { BinanceWeb3Client } from "@redeye/clients";
import { createBinanceStatus } from "./binance-status.js";

describe("createBinanceStatus", () => {
  it("tallies calls per module and lists Binance's bStock status", async () => {
    let status: ReturnType<typeof createBinanceStatus> | null = null;
    const client = new BinanceWeb3Client({
      apiKey: "k",
      secret: "s",
      maxAttempts: 1,
      onCall: (call) => status?.record(call),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            code: 0,
            success: true,
            data: [
              {
                tokenContractAddress: "0x02fc",
                underlyingTicker: "NVDA",
                tokenSymbol: "NVDAB",
                tokenToShareRatio: "1.000778",
                statusInfo: { openState: true, reasonCode: "TRADING" }
              }
            ]
          }),
          { status: 200 }
        )) as typeof fetch
    });
    status = createBinanceStatus(client, () => Date.parse("2026-10-10T10:00:00Z"));
    await status.refresh();
    const view = status.status() as {
      state: string;
      modules: Record<string, { calls: number; ok: number; last: { code: number } | null }>;
      bstocks: { checkedAt: string; count: number; items: Array<Record<string, unknown>> };
    };
    expect(view.state).toBe("ok");
    expect(view.modules.rwa).toMatchObject({ calls: 1, ok: 1, last: { code: 0 } });
    expect(view.modules.trading).toMatchObject({ calls: 0, last: null });
    expect(view.bstocks).toMatchObject({ checkedAt: "2026-10-10T10:00:00.000Z", count: 1 });
    expect(view.bstocks.items[0]).toMatchObject({
      ticker: "NVDA",
      tokenToShareRatio: "1.000778",
      reasonCode: "TRADING"
    });
  });

  it("reports degraded with the error when the RWA module fails", async () => {
    const client = new BinanceWeb3Client({
      apiKey: "k",
      secret: "s",
      maxAttempts: 1,
      fetch: (async () =>
        new Response(JSON.stringify({ code: 40104, msg: "no permission" }), {
          status: 403
        })) as typeof fetch
    });
    const status = createBinanceStatus(client);
    await status.refresh();
    expect(status.status()).toMatchObject({ state: "degraded" });
    expect((status.status() as { lastError: string }).lastError).toContain("40104");
  });
});
