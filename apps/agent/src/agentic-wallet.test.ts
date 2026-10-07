import { describe, expect, it } from "vitest";
import { AgenticWallet, type BawRunner } from "./agentic-wallet.js";

const NVDA_TOKEN = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const NOW = Date.parse("2026-10-07T15:00:00.000Z");

function wallet(replies: Record<string, unknown>): { wallet: AgenticWallet; calls: string[][] } {
  const calls: string[][] = [];
  const run: BawRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const reply = replies[key];
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error(`unexpected ${key}`);
    return reply;
  };
  return {
    wallet: new AgenticWallet(
      run,
      () => NOW,
      async () => undefined
    ),
    calls
  };
}

describe("Agentic Wallet", () => {
  it("reads limits and ends the session at the earlier of its two end times", async () => {
    const { wallet: subject } = wallet({
      "wallet settings": {
        dailyLimit: 1000,
        quotaLeft: 950.5,
        tradeAllTokens: false,
        sessionExpireTime: "2026-10-09T14:54:10+00:00",
        inactiveSignOutTime: "2026-10-08T09:00:00+00:00"
      }
    });
    await expect(subject.context("20", NOW)).resolves.toEqual({
      connected: true,
      tokenAllowed: true,
      quotaLeftUsd: "950.5",
      requiredQuotaUsd: "20",
      sessionExpiresAtMs: Date.parse("2026-10-08T09:00:00+00:00"),
      requiredUntilMs: NOW
    });
  });

  it("measures a sell quote's price per real share against the displayed price", async () => {
    const { wallet: subject, calls } = wallet({
      "market-order quote": { toCoinAmount: "4.743206225404125370", slippage: 0.01 }
    });
    const quote = await subject.quote({
      side: "sell",
      tokenAddress: NVDA_TOKEN,
      multiplier: "1.000778223752807865",
      amount: "0.02",
      displayedPricePerShare: "237.5"
    });
    expect(calls[0]).toEqual([
      "market-order",
      "quote",
      "--binanceChainId",
      "56",
      "--fromTokenQty",
      "0.02",
      "--fromToken",
      NVDA_TOKEN,
      "--toToken",
      "0x55d398326f99059fF775485246999027B3197955"
    ]);
    expect(quote).toMatchObject({
      side: "sell",
      inputUnit: "TOKEN",
      outputUnit: "USD",
      outputAmount: "4.743206225404125370",
      feeUsd: "0"
    });
    // 4.7432 / (0.02 × 1.000778) = 236.976 per share, 0.2207% under 237.5.
    expect(Number(quote.priceImpactPct)).toBeCloseTo(0.2207, 3);
  });

  it("passes the wallet's own error through word for word", async () => {
    const { wallet: subject } = wallet({
      "market-order quote": new Error("Token not supported for trading")
    });
    await expect(
      subject.quote({
        side: "buy",
        tokenAddress: NVDA_TOKEN,
        multiplier: "1",
        amount: "5",
        displayedPricePerShare: "237"
      })
    ).rejects.toThrow("Token not supported for trading");
  });

  it("fails loudly when the wallet has no BNB Smart Chain address", async () => {
    const { wallet: subject } = wallet({
      "wallet address": { addresses: [{ binanceChainId: "CT_501", address: "4evj" }] }
    });
    await expect(subject.address()).rejects.toThrow("no BNB Smart Chain address");
  });
});
