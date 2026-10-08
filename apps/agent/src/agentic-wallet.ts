import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { NormalizedQuote, WalletContext } from "@redeye/core";
import Decimal from "decimal.js";

const BSC_CHAIN_ID = "56";
export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const COMMAND_TIMEOUT_MS = 60_000;
const ORDER_POLL_MS = 3_000;
const ORDER_WAIT_MS = 120_000;
const ORDER_CLOCK_SLACK_MS = 60_000;

/** An error the wallet tool reported, kept word for word. */
export class WalletError extends Error {
  constructor(
    readonly command: string,
    message: string
  ) {
    super(message);
    this.name = "WalletError";
  }
}

/** Runs one `baw` command with `--json` and returns its `data` field. */
export type BawRunner = (args: string[]) => Promise<unknown>;

export function createBawRunner(binary = "baw"): BawRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        binary,
        ["--json", ...args],
        { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const command = args.slice(0, 2).join(" ");
          let body: unknown;
          try {
            body = JSON.parse(stdout);
          } catch {
            reject(new WalletError(command, (stderr || error?.message || stdout).trim()));
            return;
          }
          const reply = body as { success?: unknown; data?: unknown; message?: unknown };
          if (reply.success !== true) {
            const message =
              typeof reply.message === "string"
                ? reply.message
                : JSON.stringify(body).slice(0, 500);
            reject(new WalletError(command, message));
            return;
          }
          resolve(reply.data);
        }
      );
    });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WalletError(field, `${field} reply is not an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * The wallet tool counts bStocks in real shares (tokens × multiplier), on quotes, swaps,
 * order lists and balances alike, while the chain and Redeye count tokens. Measured on
 * 8 Oct 2026: a swap of "0.001" NVDAB moved 0.000999222 tokens on chain.
 */
function toShares(tokens: string, multiplier: string): string {
  return new Decimal(tokens).mul(multiplier).toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed();
}

function toTokens(shares: string, multiplier: string): string {
  return new Decimal(shares).div(multiplier).toDecimalPlaces(18, Decimal.ROUND_DOWN).toFixed();
}

/** The amount the wallet tool expects for this quote's input: shares to sell, or USDT to spend. */
function walletInput(side: "buy" | "sell", amount: string, multiplier: string): string {
  return side === "sell" ? toShares(amount, multiplier) : amount;
}

function decimalText(value: unknown, field: string): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) {
    throw new WalletError(field, `${field} is not a decimal number.`);
  }
  return text;
}

export interface WalletSettings {
  dailyLimitUsd: string;
  quotaLeftUsd: string;
  tradeAllTokens: boolean;
  /** The earliest of the session's hard expiry and its inactivity sign-out. */
  sessionEndsAtMs: number;
}

export interface OrderResult {
  orderId: string;
  status: "FINISHED" | "FAILED" | "PENDING";
  txHash: `0x${string}` | null;
}

export interface QuoteRequest {
  side: "buy" | "sell";
  tokenAddress: string;
  multiplier: string;
  /** Token units to sell, or USDT to spend. */
  amount: string;
  /** The token's displayed price per real share, used to measure the quote's price impact. */
  displayedPricePerShare: string;
}

/**
 * The Binance Agentic Wallet through its `baw` command-line tool. Limits and session
 * length are set by the owner in the Binance app; this class only reads them.
 */
export class AgenticWallet {
  constructor(
    private readonly run: BawRunner,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async settings(): Promise<WalletSettings> {
    const data = record(await this.run(["wallet", "settings"]), "wallet settings");
    const ends = [data.sessionExpireTime, data.inactiveSignOutTime]
      .map((value) => (typeof value === "string" ? Date.parse(value) : NaN))
      .filter(Number.isFinite);
    if (ends.length === 0) throw new WalletError("wallet settings", "No session end time.");
    return {
      dailyLimitUsd: decimalText(data.dailyLimit, "dailyLimit"),
      quotaLeftUsd: decimalText(data.quotaLeft, "quotaLeft"),
      tradeAllTokens: data.tradeAllTokens === true,
      sessionEndsAtMs: Math.min(...ends)
    };
  }

  async address(): Promise<`0x${string}`> {
    const data = record(await this.run(["wallet", "address"]), "wallet address");
    const rows = Array.isArray(data.addresses) ? data.addresses : [];
    for (const row of rows) {
      const entry = record(row, "wallet address row");
      if (entry.binanceChainId === BSC_CHAIN_ID && typeof entry.address === "string") {
        if (!/^0x[0-9a-fA-F]{40}$/.test(entry.address)) break;
        return entry.address as `0x${string}`;
      }
    }
    throw new WalletError("wallet address", "The wallet has no BNB Smart Chain address.");
  }

  /** Wallet state for the decision rules, read fresh before every trade. */
  async context(requiredQuotaUsd: string, requiredUntilMs: number): Promise<WalletContext> {
    const settings = await this.settings();
    return {
      connected: settings.sessionEndsAtMs > this.now(),
      // The wallet decides per token; a refusal comes back from the swap itself.
      tokenAllowed: true,
      quotaLeftUsd: settings.quotaLeftUsd,
      requiredQuotaUsd,
      sessionExpiresAtMs: settings.sessionEndsAtMs,
      requiredUntilMs
    };
  }

  async quote(request: QuoteRequest): Promise<NormalizedQuote> {
    const [fromToken, toToken] =
      request.side === "sell" ? [request.tokenAddress, USDT_BSC] : [USDT_BSC, request.tokenAddress];
    const quotedAtMs = this.now();
    const data = record(
      await this.run([
        "market-order",
        "quote",
        "--binanceChainId",
        BSC_CHAIN_ID,
        "--fromTokenQty",
        walletInput(request.side, request.amount, request.multiplier),
        "--fromToken",
        fromToken,
        "--toToken",
        toToken
      ]),
      "market-order quote"
    );
    const quoted = decimalText(data.toCoinAmount, "toCoinAmount");
    // A buy's output comes back in shares; Redeye keeps token amounts.
    const outputAmount = request.side === "sell" ? quoted : toTokens(quoted, request.multiplier);
    const tokens = new Decimal(request.side === "sell" ? request.amount : outputAmount);
    const cash = new Decimal(request.side === "sell" ? outputAmount : request.amount);
    const implied = cash.div(tokens.mul(request.multiplier));
    const displayed = new Decimal(request.displayedPricePerShare);
    // The DEX fee is already inside the quoted output, so all of it shows up as impact.
    const impactPct = implied.minus(displayed).abs().div(displayed).mul(100);
    const id = createHash("sha256")
      .update(JSON.stringify({ ...request, outputAmount, quotedAtMs }))
      .digest("hex")
      .slice(0, 32);
    return {
      id,
      success: true,
      side: request.side,
      wrapper: "bStock",
      tokenAddress: request.tokenAddress,
      routeTokenAddress: request.tokenAddress,
      inputAmount: request.amount,
      inputUnit: request.side === "sell" ? "TOKEN" : "USD",
      outputAmount,
      outputUnit: request.side === "sell" ? "USD" : "TOKEN",
      multiplier: request.multiplier,
      priceImpactPct: impactPct.toSignificantDigits(12).toString(),
      feeUsd: "0",
      quotedAtMs
    };
  }

  /**
   * Places the swap and waits for a final status. A submitted order is not a trade:
   * only FINISHED counts, and a still-pending order is returned as PENDING.
   */
  async swap(quote: NormalizedQuote, slippagePct: string): Promise<OrderResult> {
    const [fromToken, toToken] =
      quote.side === "sell" ? [quote.tokenAddress, USDT_BSC] : [USDT_BSC, quote.tokenAddress];
    const sentAtMs = this.now();
    const data = record(
      await this.run([
        "market-order",
        "swap",
        "--binanceChainId",
        BSC_CHAIN_ID,
        "--fromTokenQty",
        walletInput(quote.side, quote.inputAmount, quote.multiplier),
        "--fromToken",
        fromToken,
        "--toToken",
        toToken,
        "--slippage",
        slippagePct
      ]),
      "market-order swap"
    );
    const replyId = data.orderId;
    if (typeof replyId !== "string" && typeof replyId !== "number") {
      throw new WalletError("market-order swap", "The swap reply has no order id.");
    }
    // The id in the swap reply is not the id the order is listed under (seen twice on
    // 8 Oct 2026), so the order is found by its tokens, time and amount instead.
    const deadline = this.now() + ORDER_WAIT_MS;
    for (;;) {
      const found = await this.findOrder(quote, sentAtMs, String(replyId));
      if (found !== null) return found;
      if (this.now() >= deadline) {
        return { orderId: String(replyId), status: "PENDING", txHash: null };
      }
      await this.sleep(ORDER_POLL_MS);
    }
  }

  /**
   * Finds an order placed since `sinceMs` between two tokens, for when the agent
   * restarted after submitting a swap but before saving its order id.
   */
  async findOrder(
    quote: NormalizedQuote,
    sinceMs: number,
    replyId?: string
  ): Promise<OrderResult | null> {
    const [fromToken, toToken] =
      quote.side === "sell" ? [quote.tokenAddress, USDT_BSC] : [USDT_BSC, quote.tokenAddress];
    const data = record(
      await this.run([
        "market-order",
        "list",
        "--binanceChainId",
        BSC_CHAIN_ID,
        "--fromToken",
        fromToken,
        "--toToken",
        toToken,
        "--startTime",
        // The wallet stamps the order with its own clock; allow a minute of drift.
        String(sinceMs - ORDER_CLOCK_SLACK_MS)
      ]),
      "market-order list"
    );
    const rows = (Array.isArray(data.list) ? data.list : []).map((row) =>
      record(row, "market order")
    );
    const amount = new Decimal(walletInput(quote.side, quote.inputAmount, quote.multiplier));
    const sameAmount = (row: Record<string, unknown>) => {
      try {
        return new Decimal(String(row.fromTokenQty)).eq(amount);
      } catch {
        return false;
      }
    };
    const order =
      rows.find((row) => replyId !== undefined && String(row.orderId) === replyId) ??
      rows.find(sameAmount);
    if (order === undefined || order.orderId === undefined) return null;
    return this.waitForOrder(String(order.orderId));
  }

  async waitForOrder(orderId: string): Promise<OrderResult> {
    const deadline = this.now() + ORDER_WAIT_MS;
    for (;;) {
      const data = record(
        await this.run(["market-order", "list", "--orderId", orderId]),
        "market-order list"
      );
      const rows = Array.isArray(data.list) ? data.list : [];
      const order = rows
        .map((row) => record(row, "market order"))
        .find((row) => String(row.orderId) === orderId);
      const status = order?.status;
      if (status === "FINISHED" || status === "FAILED") {
        const txHash =
          typeof order?.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(order.txHash)
            ? (order.txHash as `0x${string}`)
            : null;
        return { orderId, status, txHash };
      }
      if (this.now() >= deadline) return { orderId, status: "PENDING", txHash: null };
      await this.sleep(ORDER_POLL_MS);
    }
  }
}

export type WalletStatus =
  | {
      state: "connected";
      connected: true;
      address: `0x${string}`;
      sessionEndsAt: string;
      dailyLimitUsd: string;
      quotaLeftUsd: string;
      tradeAllTokens: boolean;
      checkedAt: string;
    }
  | { state: "disconnected"; connected: false; reason: string; checkedAt: string };

/** The wallet's state for the public /wallet route, read from the wallet tool itself. */
export async function walletStatus(wallet: AgenticWallet, now = Date.now()): Promise<WalletStatus> {
  const checkedAt = new Date(now).toISOString();
  try {
    const [settings, address] = await Promise.all([wallet.settings(), wallet.address()]);
    if (settings.sessionEndsAtMs <= now) {
      return {
        state: "disconnected",
        connected: false,
        reason: "The Agentic Wallet session has ended.",
        checkedAt
      };
    }
    return {
      state: "connected",
      connected: true,
      address,
      sessionEndsAt: new Date(settings.sessionEndsAtMs).toISOString(),
      dailyLimitUsd: settings.dailyLimitUsd,
      quotaLeftUsd: settings.quotaLeftUsd,
      tradeAllTokens: settings.tradeAllTokens,
      checkedAt
    };
  } catch (error) {
    return {
      state: "disconnected",
      connected: false,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt
    };
  }
}
