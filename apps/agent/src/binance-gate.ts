import Decimal from "decimal.js";
import type { BinanceCall, BinanceEvidence, QuoteCheckResult } from "@redeye/core";
import { BSC_CHAIN_ID, type BinanceWeb3Client, type Web3CallRecord } from "@redeye/clients";
import { keccak256, type Hex } from "viem";

export const BSC_USDT = "0x55d398326f99059fF775485246999027B3197955";
/** Binance's own quote and the wallet's quote may differ by this much before a trade waits. */
export const QUOTE_DEVIATION_LIMIT_PCT = "1.5";
/** Shares per token from Binance and from the wallet's list may differ by this much. */
export const SHARE_RATIO_TOLERANCE_PCT = "0.5";
const TOKEN_DECIMALS = 18;

export interface BinanceGateRequest {
  tokenAddress: string;
  side: "buy" | "sell";
  /** The wallet quote's input: tokens when selling, USDT when buying. */
  inputAmount: string;
  /** The wallet quote's output: USDT when selling, tokens when buying. */
  walletOutputAmount: string;
  /** The address that will trade, needed by Binance for stock-token routes. */
  account: string;
  /** The PlanAccount door's exact transaction; dry-run and checked before the decision. */
  exactCall?: ExactCallSummary;
}

export interface ExactCallSummary {
  from: string;
  to: string;
  value: bigint;
  data: string;
  /** The address whose balances the swap changes (the PlanAccount owner). */
  owner: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
}

interface SimulationAnswer {
  status?: string;
  failReason?: string | null;
  balanceChanges?: Array<{ contractAddress?: string; change?: string; owner?: string }>;
}

/** Checks a dry run's predicted balance changes against the swap's own bounds. */
export function checkSimulation(
  answer: SimulationAnswer,
  call: ExactCallSummary
): {
  passed: boolean;
  detail: string;
} {
  if (answer.status !== "SUCCESS") {
    return {
      passed: false,
      detail: `dry run ${answer.status ?? "unknown"}: ${answer.failReason ?? "no reason given"}`
    };
  }
  const owner = call.owner.toLowerCase();
  const changeOf = (token: string) =>
    (answer.balanceChanges ?? [])
      .filter(
        (c) =>
          c.owner?.toLowerCase() === owner &&
          c.contractAddress?.toLowerCase() === token.toLowerCase()
      )
      .reduce((sum, c) => sum + BigInt(c.change ?? "0"), 0n);
  const received = changeOf(call.tokenOut);
  const spent = -changeOf(call.tokenIn);
  if (received < call.minAmountOut) {
    return {
      passed: false,
      detail: `dry run gives the owner ${received} of ${call.tokenOut}, below the minimum ${call.minAmountOut}`
    };
  }
  if (spent > call.amountIn) {
    return {
      passed: false,
      detail: `dry run spends ${spent} of ${call.tokenIn}, above the signed ${call.amountIn}`
    };
  }
  return {
    passed: true,
    detail: `owner receives ${received} and spends ${spent}, inside the signed bounds`
  };
}

export type BinanceGate = (request: BinanceGateRequest) => Promise<BinanceEvidence>;

interface RwaTokenRow {
  tokenContractAddress?: string;
  tokenToShareRatio?: string;
  tokenPrice?: string;
  referencePrice?: string;
  statusInfo?: {
    openState?: boolean;
    marketStatus?: string | null;
    reasonCode?: string | null;
    reasonMsg?: string | null;
    nextOpenTime?: number | null;
  };
}

interface QuoteRow {
  quoteId?: string;
  vendorName?: string;
  executionMode?: string;
  toTokenAmount?: string;
  isBest?: boolean;
  toToken?: { decimal?: string };
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function raw(amount: string): string {
  return new Decimal(amount)
    .mul(new Decimal(10).pow(TOKEN_DECIMALS))
    .toFixed(0, Decimal.ROUND_DOWN);
}

function toCall(call: Web3CallRecord): BinanceCall {
  return {
    module: call.module,
    method: call.method,
    path: call.path,
    at: call.at,
    httpStatus: call.httpStatus,
    code: call.code,
    latencyMs: call.latencyMs,
    ok: call.ok
  };
}

/**
 * Runs the signed Binance Web3 API checks for one trade: the token's RWA status
 * and share ratio, Binance's market price, and Binance's own quote for the same
 * size. It never throws; a module that fails is named in `failure`, so the
 * decision refuses instead of trading without the check.
 */
export function createBinanceGate(
  client: BinanceWeb3Client,
  record: (call: Web3CallRecord) => void = () => undefined
): BinanceGate {
  return async (request) => {
    const calls: Web3CallRecord[] = [];
    const seen = (call: Web3CallRecord) => {
      calls.push(call);
      record(call);
    };
    const token = request.tokenAddress.toLowerCase();
    const evidence: BinanceEvidence = {
      v: 1,
      rwa: null,
      marketPrice: null,
      quote: null,
      simulation: null,
      failure: null,
      calls: []
    };
    const fail = (module: string, error: unknown) => {
      if (evidence.failure !== null) return;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? ((error as { code: number | null }).code ?? null)
          : null;
      evidence.failure = {
        module,
        code,
        message: error instanceof Error ? error.message : String(error)
      };
    };
    const tracked = client.withRecorder(seen);

    const exact = request.exactCall;
    const simulate = (tx: { from: string; to: string; value: string; data: string }) =>
      tracked.post<SimulationAnswer>("transaction", "/api/v1/dex/pre-transaction/simulate", {
        binanceChainId: BSC_CHAIN_ID,
        evmTx: tx
      });
    await Promise.all([
      exact === undefined
        ? Promise.resolve()
        : simulate({
            from: exact.from,
            to: exact.to,
            value: exact.value.toString(),
            data: exact.data
          })
            .then(({ data }) => {
              const verdict = checkSimulation(data ?? {}, exact);
              evidence.simulation = {
                kind: "exact",
                status: data?.status ?? "unknown",
                failReason: data?.failReason ?? null,
                callHash: keccak256(exact.data as Hex),
                ...verdict
              };
            })
            .catch((error: unknown) => fail("transaction", error)),
      tracked
        .get<RwaTokenRow[]>("rwa", "/api/v1/dex/market/rwa/tokens", {
          binanceChainId: BSC_CHAIN_ID,
          platformId: "bstock"
        })
        .then(({ data }) => {
          const row = (Array.isArray(data) ? data : []).find(
            (r) => r.tokenContractAddress?.toLowerCase() === token
          );
          if (!row) throw new Error(`token ${token} is not in Binance's RWA list`);
          evidence.rwa = {
            tokenPrice: text(row.tokenPrice),
            referencePrice: text(row.referencePrice),
            tokenToShareRatio: text(row.tokenToShareRatio),
            openState:
              typeof row.statusInfo?.openState === "boolean" ? row.statusInfo.openState : null,
            marketStatus: text(row.statusInfo?.marketStatus),
            reasonCode: text(row.statusInfo?.reasonCode),
            reasonMsg: text(row.statusInfo?.reasonMsg),
            nextOpenTime:
              typeof row.statusInfo?.nextOpenTime === "number" ? row.statusInfo.nextOpenTime : null
          };
        })
        .catch((error: unknown) => fail("rwa", error)),
      tracked
        .post<Array<{ price?: string }>>("market", "/api/v1/dex/market/price", [
          { binanceChainId: BSC_CHAIN_ID, tokenContractAddress: request.tokenAddress }
        ])
        .then(({ data }) => {
          evidence.marketPrice = text(Array.isArray(data) ? data[0]?.price : null);
        })
        .catch((error: unknown) => fail("market", error)),
      tracked
        .get<QuoteRow[]>("trading", "/api/v1/dex/aggregator/quote", {
          binanceChainId: BSC_CHAIN_ID,
          amount: raw(request.inputAmount),
          fromTokenAddress: request.side === "sell" ? request.tokenAddress : BSC_USDT,
          toTokenAddress: request.side === "sell" ? BSC_USDT : request.tokenAddress,
          userWalletAddress: request.account
        })
        .then(({ data }) => {
          const rows = Array.isArray(data) ? data : [];
          const best = rows.find((r) => r.isBest) ?? rows[0];
          if (!best?.toTokenAmount) throw new Error("Binance returned no route for this size");
          const decimals = Number(best.toToken?.decimal ?? TOKEN_DECIMALS);
          const output = new Decimal(best.toTokenAmount).div(new Decimal(10).pow(decimals));
          const wallet = new Decimal(request.walletOutputAmount);
          const deviation = output.isZero()
            ? new Decimal(100)
            : wallet.minus(output).abs().div(output).mul(100);
          evidence.quote = {
            vendor: best.vendorName ?? "unknown",
            executionMode: best.executionMode ?? "unknown",
            quoteId: best.quoteId ?? "",
            inputAmount: request.inputAmount,
            outputAmount: output.toFixed(),
            walletOutputAmount: wallet.toString(),
            deviationPct: deviation.toDecimalPlaces(4).toString(),
            limitPct: QUOTE_DEVIATION_LIMIT_PCT
          };
        })
        .catch((error: unknown) => fail("trading", error))
    ]);
    // No dry run for the Agentic Wallet door: it builds its own transaction and does not
    // expose it, and Binance's route for the same swap needs an approval first, which a
    // single-transaction dry run cannot include (see docs/dx-log.md, 10 Oct 10:19 UTC).
    evidence.calls = calls.map(toCall);
    return evidence;
  };
}

/**
 * Folds the Binance evidence into the wallet quote's check. A passing wallet check
 * becomes a named failure when a Binance module did not answer, when Binance's
 * share ratio disagrees with the listed one, or when Binance's quote for the same
 * size is too far from the wallet's. A check that already failed is kept as is.
 */
export function applyBinanceEvidence(
  check: QuoteCheckResult,
  evidence: BinanceEvidence,
  listedMultiplier: string,
  side: "buy" | "sell"
): QuoteCheckResult {
  if (!check.passed) return check;
  if (evidence.failure !== null) {
    return {
      ...check,
      passed: false,
      code: "BINANCE_API_UNAVAILABLE",
      stage: "binance",
      reason: `Binance ${evidence.failure.module} module: ${evidence.failure.message}`
    };
  }
  if (evidence.simulation?.kind === "exact" && !evidence.simulation.passed) {
    return {
      ...check,
      passed: false,
      code: "SIM_FAILED",
      stage: "simulation",
      reason: evidence.simulation.detail
    };
  }
  const ratio = evidence.rwa?.tokenToShareRatio;
  if (ratio) {
    const listed = new Decimal(listedMultiplier);
    const gap = new Decimal(ratio).minus(listed).abs().div(listed).mul(100);
    if (gap.gt(SHARE_RATIO_TOLERANCE_PCT)) {
      return {
        ...check,
        passed: false,
        code: "MULTIPLIER_MISMATCH",
        stage: "binance",
        reason: `Binance RWA says one token is ${ratio} shares; the listed multiplier is ${listedMultiplier}.`,
        multiplierA: listedMultiplier,
        multiplierB: ratio
      };
    }
  }
  const quote = evidence.quote;
  if (quote && new Decimal(quote.deviationPct).gt(quote.limitPct)) {
    const multiplier = new Decimal(ratio ?? listedMultiplier);
    const perShare = (output: string) =>
      side === "sell"
        ? new Decimal(output).div(new Decimal(quote.inputAmount).mul(multiplier))
        : new Decimal(quote.inputAmount).div(new Decimal(output).mul(multiplier));
    return {
      ...check,
      passed: false,
      code: "QUOTE_DEVIATION_EXCEEDED",
      stage: "binance",
      reason: `Binance's quote differs from the wallet's by ${quote.deviationPct}% (limit ${quote.limitPct}%).`,
      impliedPricePerShare: perShare(quote.walletOutputAmount).toDecimalPlaces(4).toString(),
      referencePricePerShare: perShare(quote.outputAmount).toDecimalPlaces(4).toString(),
      deviationPct: quote.deviationPct
    };
  }
  return check;
}

/** What Binance's Wallet API saw for one fill, next to the chain's own record. */
export interface BinanceFillCheck {
  v: 1;
  at: string;
  txStatus: string | null;
  sent: { token: string; amount: string } | null;
  received: { token: string; amount: string } | null;
  /** The wallet's receipt as the chain reconciliation recorded it. */
  chainReceived: string | null;
  matchesChain: boolean;
  detail: string;
}

export interface BinanceFillRequest {
  txHash: string;
  wallet: string;
  sentToken: string;
  receivedToken: string;
  chainReceived: string | null;
}

interface TxDetail {
  txStatus?: string;
  tokenTransferDetails?: Array<{
    from?: string;
    to?: string;
    tokenContractAddress?: string;
    amount?: string;
  }>;
}

/**
 * Asks Binance's Wallet API what the wallet sent and received in a fill and compares
 * it with the chain's own record. Evidence only: the chain reconciliation decides.
 * Returns null while Binance has not indexed the transaction yet.
 */
export function createBinanceFillCheck(client: BinanceWeb3Client, now: () => number = Date.now) {
  return async (request: BinanceFillRequest): Promise<BinanceFillCheck | null> => {
    const { data } = await client.get<TxDetail[] | TxDetail>(
      "wallet",
      "/api/v1/dex/post-transaction/transaction-detail-by-txhash",
      { binanceChainId: BSC_CHAIN_ID, txHash: request.txHash }
    );
    const detail = Array.isArray(data) ? data[0] : data;
    if (!detail?.txStatus) return null;
    const wallet = request.wallet.toLowerCase();
    const sum = (token: string, side: "from" | "to") =>
      (detail.tokenTransferDetails ?? [])
        .filter(
          (t) =>
            t[side]?.toLowerCase() === wallet &&
            t.tokenContractAddress?.toLowerCase() === token.toLowerCase()
        )
        .reduce((total, t) => total.plus(t.amount || "0"), new Decimal(0));
    const sent = sum(request.sentToken, "from");
    const received = sum(request.receivedToken, "to");
    const matches =
      detail.txStatus === "success" &&
      request.chainReceived !== null &&
      received.eq(request.chainReceived);
    return {
      v: 1,
      at: new Date(now()).toISOString(),
      txStatus: detail.txStatus,
      sent: { token: request.sentToken, amount: sent.toFixed() },
      received: { token: request.receivedToken, amount: received.toFixed() },
      chainReceived: request.chainReceived,
      matchesChain: matches,
      detail: matches
        ? `Binance and the chain agree: the wallet received ${received.toFixed()}.`
        : `Binance reports ${received.toFixed()} received (status ${detail.txStatus}); the chain recorded ${request.chainReceived ?? "nothing"}.`
    };
  };
}
