import { describe, expect, it } from "vitest";
import type { BinanceEvidence, QuoteCheckResult } from "@redeye/core";
import { BinanceWeb3Client } from "@redeye/clients";
import { applyBinanceEvidence, BSC_USDT, createBinanceGate } from "./binance-gate.js";

const TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const ACCOUNT = "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2";

const passed: QuoteCheckResult = {
  quoteId: "q1",
  passed: true,
  code: null,
  stage: "all",
  reason: "ok",
  impliedPricePerShare: "230",
  referencePricePerShare: "230",
  deviationPct: "0",
  effectiveCostPerShare: null,
  multiplierSources: null,
  multiplierA: null,
  multiplierB: null,
  displayedPricePerShare: null,
  sizedPricePerShare: null
} as QuoteCheckResult;

function evidence(over: Partial<BinanceEvidence> = {}): BinanceEvidence {
  return {
    v: 1,
    rwa: {
      tokenPrice: "230.35",
      referencePrice: "230.17",
      tokenToShareRatio: "1.000778",
      openState: true,
      marketStatus: null,
      reasonCode: "TRADING",
      reasonMsg: null,
      nextOpenTime: null
    },
    marketPrice: "230.35",
    quote: {
      vendor: "LiquidMesh",
      executionMode: "SWAP",
      quoteId: "b1",
      inputAmount: "0.01",
      outputAmount: "2.30",
      walletOutputAmount: "2.31",
      deviationPct: "0.4348",
      limitPct: "1.5"
    },
    failure: null,
    calls: [],
    ...over
  };
}

describe("applyBinanceEvidence", () => {
  it("keeps a passing check when Binance agrees", () => {
    expect(applyBinanceEvidence(passed, evidence(), "1.000778", "sell")).toBe(passed);
  });

  it("names the module that did not answer", () => {
    const result = applyBinanceEvidence(
      passed,
      evidence({ failure: { module: "trading", code: 50001, message: "service unavailable" } }),
      "1",
      "sell"
    );
    expect(result).toMatchObject({
      passed: false,
      code: "BINANCE_API_UNAVAILABLE",
      stage: "binance"
    });
    expect(result.reason).toContain("trading module: service unavailable");
  });

  it("refuses when Binance's share ratio disagrees with the listed multiplier", () => {
    const result = applyBinanceEvidence(passed, evidence(), "1.02", "sell");
    expect(result).toMatchObject({
      code: "MULTIPLIER_MISMATCH",
      multiplierA: "1.02",
      multiplierB: "1.000778"
    });
  });

  it("refuses when the two quotes disagree, with per-share prices for the sentence", () => {
    const e = evidence();
    e.quote = {
      ...e.quote!,
      outputAmount: "2.00",
      walletOutputAmount: "2.30",
      deviationPct: "15",
      limitPct: "1.5"
    };
    const result = applyBinanceEvidence(passed, e, "1.000778", "sell");
    expect(result.code).toBe("QUOTE_DEVIATION_EXCEEDED");
    // 2.30 / (0.01 × 1.000778) and 2.00 / (0.01 × 1.000778)
    expect(result.impliedPricePerShare).toBe("229.8212");
    expect(result.referencePricePerShare).toBe("199.8445");
  });

  it("never turns an earlier failure into a pass", () => {
    const failed = { ...passed, passed: false, code: "IMPACT_TOO_HIGH" } as QuoteCheckResult;
    expect(applyBinanceEvidence(failed, evidence(), "1", "sell")).toBe(failed);
  });
});

describe("createBinanceGate", () => {
  function client(answer: (url: string, init: RequestInit) => unknown) {
    const urls: string[] = [];
    const c = new BinanceWeb3Client({
      apiKey: "k",
      secret: "s",
      sleep: async () => undefined,
      maxAttempts: 1,
      fetch: (async (url: string, init: RequestInit) => {
        urls.push(url);
        const body = answer(url, init);
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch
    });
    return { c, urls };
  }

  it("asks Binance for the same trade and measures the quote gap", async () => {
    const { c, urls } = client((url) => {
      if (url.includes("/rwa/tokens"))
        return {
          code: 0,
          success: true,
          data: [
            {
              tokenContractAddress: TOKEN,
              tokenToShareRatio: "1.000778",
              tokenPrice: "230.35",
              referencePrice: "230.17",
              statusInfo: { openState: true, reasonCode: "TRADING" }
            }
          ]
        };
      if (url.includes("/market/price"))
        return { code: 0, success: true, data: [{ price: "230.35" }] };
      return {
        code: 0,
        success: true,
        data: [
          {
            quoteId: "b1",
            vendorName: "LiquidMesh",
            executionMode: "SWAP",
            isBest: true,
            toTokenAmount: "2305275685853186634",
            toToken: { decimal: "18" }
          }
        ]
      };
    });
    const gate = createBinanceGate(c);
    const result = await gate({
      tokenAddress: TOKEN,
      side: "sell",
      inputAmount: "0.01",
      walletOutputAmount: "2.3",
      account: ACCOUNT
    });
    expect(result.failure).toBeNull();
    expect(result.rwa).toMatchObject({ tokenToShareRatio: "1.000778", reasonCode: "TRADING" });
    expect(result.marketPrice).toBe("230.35");
    expect(result.quote).toMatchObject({
      vendor: "LiquidMesh",
      outputAmount: "2.305275685853186634",
      deviationPct: "0.2289"
    });
    const quoteUrl = urls.find((u) => u.includes("/aggregator/quote"))!;
    expect(quoteUrl).toContain("amount=10000000000000000");
    expect(quoteUrl).toContain(`fromTokenAddress=${TOKEN}`);
    expect(quoteUrl).toContain(`toTokenAddress=${BSC_USDT}`);
    expect(quoteUrl).toContain(`userWalletAddress=${ACCOUNT}`);
    expect(result.calls.map((call) => call.module).sort()).toEqual(["market", "rwa", "trading"]);
  });

  it("records a failing module instead of throwing", async () => {
    const { c } = client((url) =>
      url.includes("/rwa/tokens")
        ? { code: 50001, msg: "service unavailable", success: false }
        : { code: 0, success: true, data: [] }
    );
    const result = await createBinanceGate(c)({
      tokenAddress: TOKEN,
      side: "buy",
      inputAmount: "5",
      walletOutputAmount: "0.02",
      account: ACCOUNT
    });
    expect(result.failure).toMatchObject({ module: "rwa", code: 50001 });
  });
});
