import { describe, expect, it } from "vitest";
import { AgenticWallet, walletStatus, type BawRunner } from "./agentic-wallet.js";

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
      // The wallet tool counts shares: 0.02 tokens × 1.000778223752807865.
      "0.020015564475056157",
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

  it("turns a buy quote's share output back into tokens", async () => {
    const { wallet: subject } = wallet({
      "market-order quote": { toCoinAmount: "0.021000", slippage: 0.01 }
    });
    const quote = await subject.quote({
      side: "buy",
      tokenAddress: NVDA_TOKEN,
      multiplier: "1.000778223752807865",
      amount: "5",
      displayedPricePerShare: "237.5"
    });
    expect(quote.outputUnit).toBe("TOKEN");
    expect(Number(quote.outputAmount)).toBeCloseTo(0.021 / Number("1.000778223752807865"), 15);
    // 5 USDT for 0.021 shares is 238.095 per share, 0.2506% over 237.5.
    expect(Number(quote.priceImpactPct)).toBeCloseTo(0.2506, 3);
  });

  it("finds a swap's order by amount when the reply's id is not the listed one", async () => {
    const listed = {
      orderId: "26100800001951112134",
      fromTokenQty: "0.001",
      status: "FINISHED",
      txHash: `0x${"b9".repeat(32)}`
    };
    const other = { ...listed, orderId: "26100800001951110000", fromTokenQty: "0.5" };
    const calls: string[][] = [];
    const run: BawRunner = async (args) => {
      calls.push(args);
      if (args[1] === "swap") return { orderId: "26100800001951112362" };
      if (args.includes("--orderId")) {
        const id = args[args.indexOf("--orderId") + 1];
        return { list: [listed, other].filter((row) => row.orderId === id) };
      }
      return { list: [other, listed] };
    };
    const subject = new AgenticWallet(
      run,
      () => NOW,
      async () => undefined
    );
    const result = await subject.swap(
      {
        id: "q",
        success: true,
        side: "sell",
        wrapper: "bStock",
        tokenAddress: NVDA_TOKEN,
        routeTokenAddress: NVDA_TOKEN,
        // 0.001 shares in tokens.
        inputAmount: "0.000999222381408451",
        inputUnit: "TOKEN",
        outputAmount: "0.23",
        outputUnit: "USD",
        multiplier: "1.000778223752807865",
        priceImpactPct: "0.1",
        feeUsd: "0",
        quotedAtMs: NOW
      },
      "1"
    );
    expect(result).toEqual({
      orderId: "26100800001951112134",
      status: "FINISHED",
      txHash: listed.txHash
    });
    const list = calls.find((args) => args[1] === "list" && args.includes("--startTime"))!;
    expect(list[list.indexOf("--startTime") + 1]).toBe(String(NOW - 60_000));
  });

  it("reports the wallet as connected, or why it is not", async () => {
    const settings = {
      dailyLimit: 1000,
      quotaLeft: 999.5,
      tradeAllTokens: false,
      sessionExpireTime: "2026-10-10T17:35:09+00:00",
      inactiveSignOutTime: "2026-10-10T17:35:09+00:00"
    };
    const address = {
      addresses: [{ binanceChainId: "56", address: "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2" }]
    };
    const { wallet: live } = wallet({ "wallet settings": settings, "wallet address": address });
    expect(await walletStatus(live, NOW)).toEqual({
      state: "connected",
      connected: true,
      address: "0xDA11FAba6da586c4EEE689b3387Af0b0fd00aae2",
      sessionEndsAt: "2026-10-10T17:35:09.000Z",
      dailyLimitUsd: "1000",
      quotaLeftUsd: "999.5",
      tradeAllTokens: false,
      checkedAt: new Date(NOW).toISOString()
    });
    const ended = walletStatus(live, Date.parse("2026-10-11T00:00:00Z"));
    expect(await ended).toMatchObject({
      connected: false,
      reason: "The Agentic Wallet session has ended."
    });
    const { wallet: signedOut } = wallet({
      "wallet settings": new Error("Not signed in"),
      "wallet address": address
    });
    expect(await walletStatus(signedOut, NOW)).toMatchObject({
      state: "disconnected",
      reason: "Not signed in"
    });
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
